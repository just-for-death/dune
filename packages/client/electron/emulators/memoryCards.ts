import * as fs from 'fs';
import * as path from 'path';

export interface MemoryCard {
  emulator: 'pcsx2' | 'duckstation' | 'pcsx';
  path: string;
  name: string;
}

export function findMemoryCards(root: string, extensions: string[]): MemoryCard[] {
  if (!fs.existsSync(root)) return [];
  const wanted = new Set(extensions.map((ext) => ext.toLowerCase()));
  const results: MemoryCard[] = [];
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
      if (entry.isDirectory()) stack.push(full);
      else if (wanted.has(path.extname(entry.name).toLowerCase())) {
        results.push({ emulator: 'pcsx2', path: full, name: entry.name });
      }
    }
  }
  return results;
}
