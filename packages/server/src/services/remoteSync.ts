import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { database } from '../db/index.js';

const execFileAsync = promisify(execFile);
const SAVES_DIR = path.join(process.cwd(), 'data', 'saves');

export async function triggerRemoteSync(syncedGames: string[]): Promise<void> {
  const settings = database.getSettings();
  const remoteServers = settings.remoteServers || [];
  
  if (remoteServers.length === 0) return;

  for (const gameName of syncedGames) {
    const gameDir = path.join(SAVES_DIR, gameName);
    if (!fs.existsSync(gameDir)) continue;

    const zipPath = path.join(SAVES_DIR, `${gameName}_sync.zip`);
    
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
          console.log(`[RemoteSync] Synced ${gameName} to ${server.url}`);
        } catch (err) {
          console.error(`[RemoteSync] Failed to push ${gameName} to ${server.url}:`, err instanceof Error ? err.message : String(err));
        }
      }
    } catch (err) {
      console.error(`[RemoteSync] Failed to zip ${gameName}:`, err instanceof Error ? err.message : String(err));
    } finally {
      if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    }
  }
}
