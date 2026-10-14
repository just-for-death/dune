import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { database, writeDB, withDbLock } from '../db/index.js';
import { getGameRoot, validateGamePath, savesDir } from '../utils/path.js';
import { syncLocalFolder, findSaveFolders } from './localScanner.js';
import { triggerRemoteSync } from './remoteSync.js';
import { logger } from '../middleware/logging.js';

const execFileAsync = promisify(execFile);

function savesRoot(): string {
  return savesDir();
}

export interface SyncProgress {
  percent: number;
  message: string;
}

export type ProgressCallback = (progress: SyncProgress) => void;

export async function performCloudSyncWithProgress(
  _credentials: { url: string },
  _progress: ProgressCallback
): Promise<{ success: boolean; message: string }> {
  return { success: true, message: 'Server-side sync not implemented - client pushes to server' };
}

export async function performCloudRestoreWithProgress(
  _credentials: { url: string },
  _progress: ProgressCallback
): Promise<{ success: boolean; message: string }> {
  return { success: false, message: 'Restore not applicable on server' };
}

export async function handleUploadFile(
  gameName: string,
  filePath: string,
  fileStream: NodeJS.ReadableStream,
  syncId: string
): Promise<{ success: boolean; message: string; status?: number }> {
  try {
    const finalPath = validateGamePath(gameName, filePath);
    const finalDir = path.dirname(finalPath);

    const maxUploadBytes =
      Math.max(1, parseInt(process.env.MAX_UPLOAD_MB || '500', 10)) * 1024 * 1024;
    const maxFilesPerGame =
      Math.max(1, parseInt(process.env.MAX_FILES_PER_GAME || '5000', 10));

    // Per-game file-count cap (cheap guard against zip-bombs / runaway syncs)
    try {
      const gameRoot = getGameRoot(gameName);
      if (fs.existsSync(gameRoot) && !fs.existsSync(finalPath)) {
        let count = 0;
        const stack: string[] = [gameRoot];
        while (stack.length > 0) {
          const dir = stack.pop() as string;
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === '.versions') continue;
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
            else if (++count >= maxFilesPerGame) {
              return { success: false, message: `Game already has ${maxFilesPerGame} files`, status: 413 };
            }
          }
        }
      }
    } catch {
      // Best-effort guard only; never block uploads on counting errors
    }

    if (!fs.existsSync(finalDir)) {
      fs.mkdirSync(finalDir, { recursive: true });
    }

    if (fs.existsSync(finalPath)) {
      const versionDir = path.join(getGameRoot(gameName), '.versions', syncId);
      const archivePath = path.join(versionDir, filePath);
      
      if (!fs.existsSync(path.dirname(archivePath))) {
        fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      }
      fs.copyFileSync(finalPath, archivePath);

      const settings = database.getSettings();
      const maxVersions = settings.maxVersions || 10;
      const versionsRoot = path.join(getGameRoot(gameName), '.versions');
      
      if (fs.existsSync(versionsRoot)) {
        const versions = fs.readdirSync(versionsRoot)
          .filter(v => !isNaN(Number(v)))
          .sort((a, b) => Number(b) - Number(a));

        if (versions.length > maxVersions) {
          versions.slice(maxVersions).forEach(v => {
            fs.rmSync(path.join(versionsRoot, v), { recursive: true, force: true });
          });
        }
      }
    }

    await new Promise<void>((resolve, reject) => {
      const destroyStream = (s: unknown) => {
        const d = (s as { destroy?: () => void }).destroy;
        if (typeof d === 'function') d.call(s);
      };
      // Open synchronously: createWriteStream opens lazily/async, and an
      // unlink issued before that open completes would be undone when the
      // pending open recreates the file (flaky leftover partial uploads).
      const fd = fs.openSync(finalPath, 'w');
      const writer = fs.createWriteStream(finalPath, { fd, autoClose: true });
      let bytes = 0;
      let rejected = false;
      fileStream.on('data', (chunk: Buffer) => {
        if (rejected) return;
        bytes += chunk.length;
        if (bytes > maxUploadBytes) {
          rejected = true;
          fileStream.unpipe(writer);
          destroyStream(fileStream);
          writer.destroy();
          try { fs.unlinkSync(finalPath); } catch { /* partial file cleanup */ }
          reject(new Error(`File exceeds ${Math.round(maxUploadBytes / 1024 / 1024)} MB limit`));
        }
      });
      fileStream.pipe(writer);
      fileStream.on('error', reject);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    if (path.basename(filePath) === 'saves.zip') {
      try {
        const tempExtractDir = path.join(getGameRoot(gameName), '_extract_tmp');
        if (fs.existsSync(tempExtractDir)) fs.rmSync(tempExtractDir, { recursive: true });
        fs.mkdirSync(tempExtractDir, { recursive: true });

        await execFileAsync('unzip', ['-o', finalPath, '-d', tempExtractDir]);
        await fs.promises.cp(tempExtractDir, getGameRoot(gameName), { recursive: true });

        fs.rmSync(tempExtractDir, { recursive: true });
        fs.unlinkSync(finalPath);
      } catch (err) {
        logger.error({ err }, 'Failed to extract saves.zip');
      }
    }

    // Status update re-reads inside the lock: awaits above (streaming
    // upload, unzip) yield, so a snapshot taken earlier could clobber
    // a concurrent upload's update.
    await withDbLock(() => {
      const timestamp = new Date().toISOString();
      const games = database.getGames();
      const gameIdx = games.findIndex(g => g.name.toLowerCase() === gameName.toLowerCase());

      if (gameIdx !== -1) {
        games[gameIdx].status = 'In Sync';
        games[gameIdx].lastSync = timestamp;
        games[gameIdx].updatedAt = timestamp;
      } else {
        games.push({
          id: Date.now() + Math.random(),
          name: gameName,
          status: 'In Sync',
          lastSync: timestamp,
          thumbnail: '',
          createdAt: timestamp,
          updatedAt: timestamp
        });
      }

      // Atomic write - single DB update
      writeDB({ games, settings: database.getSettings() });
    });

    setImmediate(() => {
      triggerRemoteSync([gameName]).catch(err => logger.error({ err }, 'Remote sync error'));
    });

    return { success: true, message: `Uploaded ${gameName} saves` };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes('exceeds') || message.includes('already has') ? 413 : undefined;
    return status ? { success: false, message, status } : { success: false, message };
  }
}

export async function handleLocalSync(): Promise<{ success: boolean; count: number; games: string[] }> {
  const settings = database.getSettings();
  const sources = settings.localSources || [];
  const maxVersions = settings.maxVersions || 10;
  let totalFilesSynced = 0;
  const syncedGames: string[] = [];

  for (const source of sources) {
    if (!fs.existsSync(source.path)) continue;

    const gamesInSource = findSaveFolders(source.path, 3);
    for (const gamePath of gamesInSource) {
      const gameName = path.basename(gamePath);
      const result = syncLocalFolder(gamePath, gameName, savesRoot(), maxVersions);

      if (result.filesSynced > 0) {
        totalFilesSynced += result.filesSynced;
        syncedGames.push(gameName);

        // Serialize against concurrent uploads: upsertGame is
        // read-modify-write, and the FS work above awaits, so an
        // unlocked upsert here could clobber a parallel status update.
        await withDbLock(() => {
          const ts = new Date().toISOString();
          database.upsertGame({
            id: Date.now() + Math.random(),
            name: gameName,
            status: 'In Sync',
            lastSync: ts,
            thumbnail: '',
            createdAt: ts,
            updatedAt: ts,
          });
        });
      }
    }
  }

  if (syncedGames.length > 0) {
    const uniqueGames = [...new Set(syncedGames)];
    setImmediate(() => {
      triggerRemoteSync(uniqueGames).catch(err => logger.error({ err }, 'Remote sync error'));
    });
  }

  return { success: true, count: totalFilesSynced, games: syncedGames };
}
