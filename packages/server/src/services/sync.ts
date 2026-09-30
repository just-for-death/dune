import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { database, writeDB } from '../db/index.js';
import { normalizeUrl, getGameRoot, validateGamePath } from '../utils/path.js';
import { syncLocalFolder, findSaveFolders } from './localScanner.js';
import { triggerRemoteSync } from './remoteSync.js';

const execFileAsync = promisify(execFile);

const SAVES_DIR = path.join(process.cwd(), 'data', 'saves');

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
): Promise<{ success: boolean; message: string }> {
  try {
    const finalPath = validateGamePath(gameName, filePath);
    const finalDir = path.dirname(finalPath);
    
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
      const writer = fs.createWriteStream(finalPath);
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
        console.error('Failed to extract saves.zip:', err);
      }
    }

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

    setImmediate(() => {
      triggerRemoteSync([gameName]).catch(err => console.error('Remote sync error:', err));
    });

    return { success: true, message: `Uploaded ${gameName} saves` };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message };
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
      const result = syncLocalFolder(gamePath, gameName, SAVES_DIR, maxVersions);

      if (result.filesSynced > 0) {
        totalFilesSynced += result.filesSynced;
        syncedGames.push(gameName);

        const ts = new Date().toISOString();
        database.upsertGame({
          id: Date.now() + Math.random(),
          name: gameName,
          status: 'In Sync',
          lastSync: ts,
          thumbnail: '',
          createdAt: ts,
          updatedAt: ts
        });
      }
    }
  }

  if (syncedGames.length > 0) {
    const uniqueGames = [...new Set(syncedGames)];
    setImmediate(() => {
      triggerRemoteSync(uniqueGames).catch(err => console.error('Remote sync error:', err));
    });
  }

  return { success: true, count: totalFilesSynced, games: syncedGames };
}
