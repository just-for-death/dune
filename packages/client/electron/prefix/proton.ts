import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ProtonVersion {
  name: string;
  path: string;
  version: string;
}

export function getProtonRoots(): string[] {
  const value = process.env.PROTON_ROOTS;
  if (value) return value.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
  const home = os.homedir();
  return [
    path.join(home, '.steam', 'steam', 'steamapps', 'common'),
    path.join(home, '.local', 'share', 'Steam', 'steamapps', 'common'),
  ];
}

export function isProtonDir(dir: string): boolean {
  return path.basename(dir).toLowerCase().startsWith('proton') && fs.existsSync(path.join(dir, 'proton'));
}

export function listProtonVersions(roots: string[] = getProtonRoots()): ProtonVersion[] {
  const versions: ProtonVersion[] = [];
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
      const protonPath = path.join(root, entry.name);
      if (!isProtonDir(protonPath)) continue;
      versions.push({ name: entry.name, path: protonPath, version: entry.name.replace(/^Proton[-_]?/i, '') || entry.name });
    }
  }
  return versions;
}
