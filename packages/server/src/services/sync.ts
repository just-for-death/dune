import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { database, writeDB, withDbLock } from '../db/index.js';
import { nextId } from '@dune/shared';
import { getGameRoot, validateGamePath, savesDir } from '../utils/path.js';
import { syncLocalFolder, findSaveFolders } from './localScanner.js';
import { triggerRemoteSync } from './remoteSync.js';
import { invalidateGame } from './manifest.js';
import { logger } from '../middleware/logging.js';

const execFileAsync = promisify(execFile);

function savesRoot(): string {
  return savesDir();
}

/**
 * Version snapshots live at `.versions/<versionId>`, so the id becomes a
 * directory name. It arrives from the `x-sync-id` header (attacker-controlled),
 * so accept digits only: anything else would let `../../x` escape the game
 * root via path.join normalization. Non-numeric ids fall back to "now".
 */
function safeVersionId(syncId: string): string {
  return /^\d+$/.test(syncId) ? syncId : Date.now().toString();
}

export interface SyncProgress {
  percent: number;
  message: string;
}

export type ProgressCallback = (progress: SyncProgress) => void;

// NOTE: Server-side sync/restore are not implemented; the client implements
// its own push/restore logic via REST. These are kept for tRPC completeness
// and throw if accidentally invoked.

export async function performCloudSyncWithProgress(
  _credentials: { url: string },
  _progress: ProgressCallback
): Promise<{ success: boolean; message: string }> {
  throw new Error('Server-side sync not implemented — client pushes to server');
}

export async function performCloudRestoreWithProgress(
  _credentials: { url: string },
  _progress: ProgressCallback
): Promise<{ success: boolean; message: string }> {
  throw new Error('Server-side restore not implemented — client pulls from server');
}

export async function handleUploadFile(
  gameName: string,
  filePath: string,
  fileStream: NodeJS.ReadableStream,
  syncId: string,
  ownerId?: string,
): Promise<{ success: boolean; message: string; status?: number }> {
  const finalPath = validateGamePath(gameName, filePath, ownerId);
  const finalDir = path.dirname(finalPath);

  const maxUploadBytes =
    Math.max(1, parseInt(process.env.MAX_UPLOAD_MB || '500', 10)) * 1024 * 1024;
  const maxFilesPerGame =
    Math.max(1, parseInt(process.env.MAX_FILES_PER_GAME || '5000', 10));

  try {
    // Per-game file-count cap (cheap guard against zip-bombs / runaway syncs)
    try {
      let count = 0;
      const gameRoot = getGameRoot(gameName, ownerId);
      if (fs.existsSync(gameRoot) && !fs.existsSync(finalPath)) {
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
      const versionDir = path.join(getGameRoot(gameName, ownerId), '.versions', safeVersionId(syncId));
      const archivePath = path.join(versionDir, filePath);

      // Guard against path traversal in the version snapshot.
      const resolvedArchive = path.resolve(archivePath);
      const resolvedVersionDir = path.resolve(versionDir);
      if (resolvedArchive !== resolvedVersionDir && !resolvedArchive.startsWith(resolvedVersionDir + path.sep)) {
        logger.warn({ gameName, filePath }, 'Rejected version snapshot outside game root');
      } else {
        if (!fs.existsSync(path.dirname(archivePath))) {
          fs.mkdirSync(path.dirname(archivePath), { recursive: true });
        }
        fs.copyFileSync(finalPath, archivePath);

        const settings = database.getSettings();
        const maxVersions = settings.maxVersions || 10;
        const versionsRoot = path.join(getGameRoot(gameName, ownerId), '.versions');

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
    }

    // Stream to a temp file first, then atomically rename onto the target.
    // Writing directly to `finalPath` (truncating) would destroy a previously
    // valid save if the upload fails partway through.
    const tmpPath = finalPath + '.uploading';
    try { fs.unlinkSync(tmpPath); } catch { /* no prior temp */ }

    await new Promise<void>((resolve, reject) => {
      const destroyStream = (s: unknown) => {
        const d = (s as { destroy?: () => void }).destroy;
        if (typeof d === 'function') d.call(s);
      };
      const fd = fs.openSync(tmpPath, 'w');
      const writer = fs.createWriteStream(tmpPath, { fd, autoClose: true });
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
          try { fs.unlinkSync(tmpPath); } catch { /* partial temp cleanup */ }
          reject(new Error(`File exceeds ${Math.round(maxUploadBytes / 1024 / 1024)} MB limit`));
        }
      });
      fileStream.pipe(writer);
      fileStream.on('error', reject);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    // Atomic publish: only replace the live file once the full upload succeeded.
    fs.renameSync(tmpPath, finalPath);

    if (path.basename(filePath) === 'saves.zip') {
      const gameRoot = getGameRoot(gameName, ownerId);
      const tempExtractDir = path.join(gameRoot, '_extract_tmp');
      try {
        if (fs.existsSync(tempExtractDir)) fs.rmSync(tempExtractDir, { recursive: true, force: true });
        fs.mkdirSync(tempExtractDir, { recursive: true });

        await execFileAsync('unzip', ['-o', finalPath, '-d', tempExtractDir]);

        // Validate every extracted entry stays inside tempExtractDir (zip-slip guard).
        const extractedFiles: string[] = [];
        const walk = (dir: string) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) throw new Error('symlink in archive');
            const full = path.join(dir, entry.name);
            const rel = path.relative(tempExtractDir, full);
            if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('path traversal in archive');
            if (entry.isDirectory()) walk(full);
            else extractedFiles.push(full);
          }
        };
        walk(tempExtractDir);

        // Enforce per-game file cap post-extraction.
        let existing = 0;
        if (fs.existsSync(gameRoot)) {
          const stack: string[] = [gameRoot];
          while (stack.length) {
            const d = stack.pop() as string;
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
              if (e.name === '.versions' || e.name === '_extract_tmp') continue;
              if (e.isSymbolicLink()) continue;
              if (e.isDirectory()) stack.push(path.join(d, e.name));
              else existing++;
            }
          }
        }
        if (existing + extractedFiles.length > maxFilesPerGame) {
          throw new Error(`Game would exceed ${maxFilesPerGame} files`);
        }

        // Copy only validated files, preserving relative paths.
        for (const src of extractedFiles) {
          const rel = path.relative(tempExtractDir, src);
          const dest = path.join(gameRoot, rel);
          const resolvedDest = path.resolve(dest);
          if (resolvedDest !== path.resolve(gameRoot) && !resolvedDest.startsWith(path.resolve(gameRoot) + path.sep)) {
            throw new Error('path traversal in archive');
          }
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(src, dest);
        }

        fs.rmSync(tempExtractDir, { recursive: true, force: true });
        fs.unlinkSync(finalPath);
      } catch (err) {
        logger.error({ err }, 'Failed to extract saves.zip');
        try { fs.rmSync(tempExtractDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }

    // Fingerprints for this game are now stale (new/overwritten files).
    invalidateGame(gameName, ownerId);

    // Status update re-reads inside the lock: awaits above (streaming
    // upload, unzip) yield, so a snapshot taken earlier could clobber
    // a concurrent upload's update.
    await withDbLock(() => {
      const timestamp = new Date().toISOString();
      const games = database.getGames();
      const gameIdx = games.findIndex(g => g.name.toLowerCase() === gameName.toLowerCase() && (g.ownerId ?? null) === (ownerId ?? null));

      if (gameIdx !== -1) {
        games[gameIdx].status = 'In Sync';
        games[gameIdx].lastSync = timestamp;
        games[gameIdx].updatedAt = timestamp;
      } else {
        games.push({
          id: nextId(),
          name: gameName,
          ownerId,
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
    try { fs.unlinkSync(finalPath + '.uploading'); } catch { /* no temp */ }
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes('exceeds') || message.includes('already has') ? 413 : undefined;
    return status ? { success: false, message, status } : { success: false, message };
  }
}

export async function handleLocalSync(ownerId?: string): Promise<{ success: boolean; count: number; games: string[]; errors: string[] }> {
  const settings = database.getSettings();
  const sources = settings.localSources || [];
  const maxVersions = settings.maxVersions || 10;
  const ownerIdResolved = ownerId ?? (database.listUsers().find(u => u.role === 'admin')?.id);
  let totalFilesSynced = 0;
  const syncedGames: string[] = [];
  const errors: string[] = [];

  // Use a single lock for the entire local sync operation to prevent
  // race conditions between concurrent syncs (from auto-sync + manual trigger)
  return withDbLock(async () => {
    for (const source of sources) {
      if (!fs.existsSync(source.path)) continue;

      let gamesInSource: string[];
      try {
        gamesInSource = findSaveFolders(source.path, 3);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ err: error, source: source.path }, 'Local sync scan failed');
        errors.push(`${source.path}: ${message}`);
        continue;
      }
      for (const gamePath of gamesInSource) {
        const gameName = path.basename(gamePath);
        let result;
        try {
          result = syncLocalFolder(gamePath, gameName, path.join(savesRoot(), ownerIdResolved ?? ''), maxVersions);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error({ err: error, game: gameName }, 'Local sync folder failed');
          errors.push(`${gameName}: ${message}`);
          continue;
        }

        if (result.filesSynced > 0) {
          totalFilesSynced += result.filesSynced;
          syncedGames.push(gameName);
          invalidateGame(gameName, ownerIdResolved);

          const ts = new Date().toISOString();
          // Omit thumbnail/analysis: omit means "preserve", so re-syncing a
          // game never wipes its cover art or AI analysis.
          database.upsertGame({
            id: nextId(),
            name: gameName,
            ownerId: ownerIdResolved,
            status: 'In Sync',
            lastSync: ts,
            createdAt: ts,
            updatedAt: ts
          });
        }
      }
    }

    if (syncedGames.length > 0) {
      const uniqueGames = [...new Set(syncedGames)];
      setImmediate(() => {
        triggerRemoteSync(uniqueGames, ownerIdResolved).catch(err => logger.error({ err }, 'Remote sync error'));
      });
    }

    if (totalFilesSynced === 0 && errors.length > 0) {
      return { success: false, count: 0, games: syncedGames, errors };
    }
    return { success: true, count: totalFilesSynced, games: syncedGames, errors };
  });
}