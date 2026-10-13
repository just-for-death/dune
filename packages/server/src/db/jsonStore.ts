import * as fs from 'node:fs';
import { logger } from '../middleware/logging.js';

/**
 * Read a JSON file, falling back safely. A corrupt file is NEVER
 * silently dropped: it is preserved beside the original with a
 * timestamp suffix so an operator can inspect/recover it.
 */
export function readJsonFile<T>(filePath: string, fallback: T, label: string): T {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch (err) {
    const backup = `${filePath}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(filePath, backup);
      logger.error({ err, file: filePath, backup }, `${label}: corrupt DB preserved, booting with defaults`);
    } catch (copyErr) {
      logger.error({ err: copyErr, file: filePath }, `${label}: corrupt DB could not be preserved`);
    }
    return fallback;
  }
}

/** Atomic write via temp file + rename (no partial reads on crash). */
export function writeJsonFileAtomic(filePath: string, data: unknown): void {
  const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.floor(Math.random() * 1e6)}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}
