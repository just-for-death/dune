import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { database } from '../db/index.js';
import { logger, redactText, redactUrl } from '../middleware/logging.js';
import { getGameRoot } from '../utils/path.js';

const execFileAsync = promisify(execFile);

/** Push each game's save tree (saves/<ownerId>/<gameId>) to configured peers. */
export async function triggerRemoteSync(syncedGames: Array<{ id: number; name: string }>, ownerId: string): Promise<void> {
  const settings = database.getSettings();
  const remoteServers = settings.remoteServers || [];
  // Shared key for server-to-server push. Remote upload routes require
  // x-api-key; without it every push 401s and only litters logs.
  // Operators set the same value on all peers via REMOTE_SYNC_API_KEY.
  const syncKey = process.env.REMOTE_SYNC_API_KEY || '';
  
  if (remoteServers.length === 0) return;

  for (const { id: gameId, name: gameName } of syncedGames) {
    // DUN-125: the folder comes from the game id (strictly inside
    // saves/<owner>); the title is only sent as the x-game header.
    let gameDir: string;
    try {
      gameDir = getGameRoot(gameId, ownerId);
    } catch (err) {
      logger.warn({ err, gameId }, 'Remote sync skipped: invalid game');
      continue;
    }
    if (!fs.existsSync(gameDir)) continue;

    const zipPath = path.join(path.dirname(gameDir), `${path.basename(gameDir)}_sync.zip`);
    
    try {
      await execFileAsync('zip', ['-r', zipPath, '.', '-x', '.versions/*'], { cwd: gameDir });

      for (const server of remoteServers) {
        // Basic SSRF check for remote server URLs
        let serverUrl: string;
        try {
          const u = new URL(server.url);
          const hostname = u.hostname.toLowerCase();
          if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal' || hostname === '100.100.100.200' || hostname === '169.254.169.253' || hostname === 'instance-data' || /^169\.254\.\d{1,3}\.\d{1,3}$/.test(hostname) || hostname.startsWith('fe80:') || hostname.startsWith('fd00:') || hostname.startsWith('[fe80:') || hostname.startsWith('[fd00:')) {
            logger.warn({ server: redactUrl(server.url) }, 'Blocked remote server with unsafe address');
            continue;
          }
          serverUrl = u.toString();
        } catch {
          logger.warn({ server: redactUrl(server.url) }, 'Invalid remote server URL');
          continue;
        }

        try {
          const stream = fs.createReadStream(zipPath);
          // Destroy the stream on failure so a rejected post never leaves
          // an open fd behind (vitest tmp cleanup noise + fd leak).
          await axios.post(new URL('/api/upload-file', serverUrl).href, stream, {
            headers: {
              'Content-Type': 'application/octet-stream',
              // DUN-064/127: peers decode these once (server.ts decodeHeader).
              'x-game': encodeURIComponent(gameName),
              'x-path': encodeURIComponent('saves.zip'),
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
          logger.info({ game: gameName, server: redactUrl(serverUrl) }, 'Remote sync pushed game');
        } catch (err) {
          // DUN-009: never log the raw AxiosError (its config/request carry the
          // x-api-key header). Only safe, flat fields.
          const e = err as { message?: unknown; code?: unknown; response?: { status?: unknown }; status?: unknown };
          const status = typeof e?.response?.status === 'number' ? e.response.status : typeof e?.status === 'number' ? e.status : undefined;
          logger.error(
            {
              game: gameName,
              server: redactUrl(serverUrl),
              message: redactText(typeof e?.message === 'string' ? e.message : String(err)),
              code: typeof e?.code === 'string' || typeof e?.code === 'number' ? e.code : undefined,
              status,
            },
            'Remote sync push failed',
          );
        }
      }
    } catch (err) {
      logger.error({ err, game: gameName }, 'Remote sync zip failed');
    } finally {
      if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    }
  }
}
