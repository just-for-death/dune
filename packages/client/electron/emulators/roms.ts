import * as fs from 'fs';
import * as path from 'path';
import { nextId } from '@dune/shared';
import type { Game } from '@dune/shared';

const ROM_EXTENSIONS = new Set([
  '.nes', '.snes', '.smc', '.sfc', '.n64', '.z64', '.v64', '.gb', '.gbc', '.gba',
  '.nds', '.3ds', '.cso', '.iso', '.bin', '.cue', '.chd', '.wbfs', '.gcm', '.rvz',
  '.md', '.gen', '.smd', '.sms', '.gg', '.pce', '.ws', '.wsc', '.a26', '.lnx',
]);

export function isRomFile(filePath: string): boolean {
  return ROM_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function scanRomFolder(folder: string, recursive = true): Game[] {
  const games: Game[] = [];
  if (!fs.existsSync(folder)) return games;

  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(fullPath);
      } else if (isRomFile(fullPath)) {
        const now = new Date().toISOString();
        games.push({
          id: nextId(),
          name: path.basename(fullPath, path.extname(fullPath)),
          winPath: '',
          linPath: fullPath,
          lastSync: 'Never',
          status: 'Pending Upload',
          thumbnail: '',
          source: 'emulator',
          sourceId: 'emulator',
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  };

  walk(folder);
  return games;
}

export function getRomRoots(): string[] {
  const value = process.env.EMULATOR_ROM_ROOTS;
  if (value) return value.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
  const home = (process.env.HOME || process.env.USERPROFILE || '').trim();
  return [path.join(home, 'ROMs'), path.join(home, 'Games', 'ROMs'), path.join(home, 'Emulation', 'roms')].filter(Boolean);
}


export function getEmulatorGames(roots?: string[]): Game[] {
  const resolvedRoots = roots ?? getRomRoots();
  const games: Game[] = [];
  for (const root of resolvedRoots) {
    games.push(...scanRomFolder(root));
  }
  return games;
}
