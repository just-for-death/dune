import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { database } from '../db/index.js';
import { logger } from '../middleware/logging.js';
import { savesDir } from '../utils/path.js';

const execFileAsync = promisify(execFile);

function savesRoot(): string {
  return savesDir();
}

export async function triggerRemoteSync(syncedGames: string[], ownerId?: string): Promise<void> {
  const settings = database.getSettings();
  const remoteServers = settings.remoteServers || [];
  // Shared key for server-to-server push. Remote upload routes require
  // x-api-key; without it every push 401s and only litters logs.
  // Operators set the same value on all peers via REMOTE_SYNC_API_KEY.
  const syncKey = process.env.REMOTE_SYNC_API_KEY || '';
  
  if (remoteServers.length === 0) return;

  for (const gameName of syncedGames) {
    const gameDir = path.join(savesRoot(), ownerId ?? '', gameName);
    if (!fs.existsSync(gameDir)) continue;

    const zipPath = path.join(savesRoot(), ownerId ?? '', `${gameName}_sync.zip`);
    
    try {
      await execFileAsync('zip', ['-r', zipPath, '.', '-x', '.versions/*'], { cwd: gameDir });

      for (const server of remoteServers) {
        // Basic SSRF check for remote server URLs
        let serverUrl: string;
        try {
          const u = new URL(server.url);
          const hostname = u.hostname.toLowerCase();
          if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal' || hostname === '100.100.100.200' || hostname === '169.254.169.253' || hostname === 'instance-data' || /^169\.254\.\d{1,3}\.\d{1,3}$/.test(hostname) || hostname.startsWith('fe80:') || hostname.startsWith('fd00:') || hostname.startsWith('[fe80:') || hostname.startsWith('[fd00:')) {
            logger.warn({ server: server.url }, 'Blocked remote server with unsafe address');
            continue;
          }
          serverUrl = u.toString();
        } catch {
          logger.warn({ server: server.url }, 'Invalid remote server URL');
          continue;
        }

        try {
          const stream = fs.createReadStream(zipPath);
          // Destroy the stream on failure so a rejected post never leaves
          // an open fd behind (vitest tmp cleanup noise + fd leak).
          await axios.post(new URL('/api/upload-file', serverUrl).href, stream, {
            headers: {
              'Content-Type': 'application/octet-stream',
              'x-game': gameName,
              'x-path': 'saves.zip',
              'x-sync-id': Date.now().toString(),
              ...(syncKey ? { 'x-api-key': syncKey } : {}),
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 300000
          }).catch((err) => {
            stream.destroy();
            throw err;
          });
          logger.info({ game: gameName, server: server.url }, 'Remote sync pushed game');
        } catch (err) {
          logger.error({ err, game: gameName, server: server.url }, 'Remote sync push failed');
        }
      }
    } catch (err) {
      logger.error({ err, game: gameName }, 'Remote sync zip failed');
    } finally {
      if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    }
  }
}
