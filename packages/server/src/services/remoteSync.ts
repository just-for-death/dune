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

export async function triggerRemoteSync(syncedGames: string[]): Promise<void> {
  const settings = database.getSettings();
  const remoteServers = settings.remoteServers || [];
  
  if (remoteServers.length === 0) return;

  for (const gameName of syncedGames) {
    const gameDir = path.join(savesRoot(), gameName);
    if (!fs.existsSync(gameDir)) continue;

    const zipPath = path.join(savesRoot(), `${gameName}_sync.zip`);
    
    try {
      await execFileAsync('zip', ['-r', zipPath, '.', '-x', '.versions/*'], { cwd: gameDir });

      for (const server of remoteServers) {
        try {
          const stream = fs.createReadStream(zipPath);
          await axios.post(`${server.url}/api/upload-file`, stream, {
            headers: {
              'Content-Type': 'application/octet-stream',
              'x-game': gameName,
              'x-path': 'saves.zip'
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 300000
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
