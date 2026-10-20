import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface HeroicPrefix {
  name: string;
  path: string;
}

export function getHeroicPrefixRoots(): string[] {
  const value = process.env.HEROIC_PREFIX_ROOTS;
  if (value) return value.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
  const home = os.homedir();
  return [
    path.join(home, '.config', 'heroic', 'prefixes'),
    path.join(home, '.var', 'app', 'com.heroicgameslauncher.hgl', 'config', 'heroic', 'prefixes'),
  ];
}

export function listHeroicPrefixes(roots: string[] = getHeroicPrefixRoots()): HeroicPrefix[] {
  const prefixes: HeroicPrefix[] = [];
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
