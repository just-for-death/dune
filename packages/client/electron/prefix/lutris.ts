import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface LutrisPrefix {
  name: string;
  path: string;
}

export function getLutrisPrefixRoots(): string[] {
  const value = process.env.LUTRIS_PREFIX_ROOTS;
  if (value) return value.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
  const home = os.homedir();
  return [path.join(home, '.local', 'share', 'lutris', 'prefixes')];
}

export function listLutrisPrefixes(roots: string[] = getLutrisPrefixRoots()): LutrisPrefix[] {
  const prefixes: LutrisPrefix[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      prefixes.push({ name: entry.name, path: path.join(root, entry.name) });
    }
  }
  return prefixes;
}
