import * as fs from 'node:fs';
import * as path from 'node:path';
import { getFileCategory } from '../utils/path.js';
import type { StorageEntry } from '@dune/shared';

export function scanStorage(root: string, lastPlayed: string | null = null): Omit<StorageEntry, 'gameId' | 'drive'> & { drive: string } {
  const saveBytesByCategory = { save: 0, config: 0, cache: 0, other: 0 };

  if (fs.existsSync(root)) {
    const stack: string[] = [root];
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else {
          try {
            const stat = fs.statSync(full);
            const rel = path.relative(root, full);
            const category = getFileCategory(rel);
            if (category === 'Save') saveBytesByCategory.save += stat.size;
            else if (category === 'Config') saveBytesByCategory.config += stat.size;
            else if (category === 'Cache') saveBytesByCategory.cache += stat.size;
            else saveBytesByCategory.other += stat.size;
          } catch {
            // Ignore unreadable files.
          }
        }
      }
    }
  }

  const drive = path.parse(path.resolve(root)).root || root;

  return {
    installBytes: 0,
    saveBytes: saveBytesByCategory.save + saveBytesByCategory.config + saveBytesByCategory.other,
    cacheBytes: saveBytesByCategory.cache,
    lastPlayed,
    drive,
  };
}

export function getDriveFreeBytes(drivePath: string): number {
  try {
    const statfs = (fs as unknown as { statfsSync?: (p: string) => { bavail: number; bsize: number } }).statfsSync?.(drivePath);
    if (statfs) return statfs.bavail * statfs.bsize;
  } catch {
    // Ignore.
  }
  return 0;
}
