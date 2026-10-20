import * as fs from 'fs';
import * as path from 'path';
import { nextId } from '@dune/shared';
import type { Game } from '@dune/shared';
import { getRetroArchConfigDir } from './detect.js';
import { getRetroArchSavePath } from './saves.js';

const ROM_EXTENSIONS = new Set([
  '.nes', '.snes', '.smc', '.sfc', '.n64', '.z64', '.v64', '.gb', '.gbc', '.gba',
  '.nds', '.3ds', '.cso', '.iso', '.bin', '.cue', '.chd', '.wbfs', '.gcm', '.rvz',
  '.md', '.gen', '.smd', '.sms', '.gg', '.pce', '.ws', '.wsc', '.a26', '.lnx',
]);

/** Candidate emulator commands per ROM extension, in preference order. */
const EMULATOR_CANDIDATES: Record<string, string[]> = {
  '.nes': ['retroarch', 'mesen'],
  '.snes': ['retroarch', 'snes9x-gtk'],
  '.smc': ['retroarch', 'snes9x-gtk'],
  '.sfc': ['retroarch', 'snes9x-gtk'],
  '.n64': ['retroarch', 'mupen64plus', 'rmg'],
  '.z64': ['retroarch', 'mupen64plus', 'rmg'],
  '.v64': ['retroarch', 'mupen64plus', 'rmg'],
  '.gb': ['retroarch', 'sameboy'],
  '.gbc': ['retroarch', 'sameboy'],
  '.gba': ['retroarch', 'mgba-qt'],
  '.nds': ['melonds', 'desmume', 'retroarch'],
  '.3ds': ['citra-qt', 'citra'],
  '.cso': ['ppsspp', 'PPSSPPSDL', 'retroarch'],
  '.iso': ['duckstation-qt', 'duckstation', 'pcsx2', 'rpcs3', 'dolphin-emu', 'ppsspp', 'retroarch'],
  '.bin': ['duckstation-qt', 'duckstation', 'pcsx2', 'retroarch'],
  '.cue': ['duckstation-qt', 'duckstation', 'pcsx2', 'retroarch'],
  '.chd': ['duckstation-qt', 'duckstation', 'pcsx2', 'retroarch'],
  '.wbfs': ['dolphin-emu', 'retroarch'],
  '.gcm': ['dolphin-emu', 'retroarch'],
  '.rvz': ['dolphin-emu', 'retroarch'],
  '.md': ['retroarch'],
  '.gen': ['retroarch'],
  '.smd': ['retroarch'],
  '.sms': ['retroarch'],
  '.gg': ['retroarch'],
  '.pce': ['retroarch'],
  '.ws': ['retroarch'],
  '.wsc': ['retroarch'],
  '.a26': ['retroarch'],
  '.lnx': ['retroarch'],
};

/**
 * Every emulator command Dune knows how to launch (DUN-061). The launcher
 * only spawns an emulator from this list; anything else is not launchable.
 */
export const KNOWN_EMULATOR_COMMANDS: readonly string[] = Array.from(new Set(Object.values(EMULATOR_CANDIDATES).flat()));

/** Folder-name hints disambiguate formats shared by several consoles (`.iso`). */
const PLATFORM_HINTS: Array<{ pattern: RegExp; candidates: string[] }> = [
  { pattern: /(?:^|[/\\])(?:ps2|playstation[ -]?2)(?:[/\\]|$)/i, candidates: ['pcsx2'] },
  { pattern: /(?:^|[/\\])(?:ps3|playstation[ -]?3)(?:[/\\]|$)/i, candidates: ['rpcs3'] },
  { pattern: /(?:^|[/\\])(?:ps1|psx|playstation)(?:[/\\]|$)/i, candidates: ['duckstation-qt', 'duckstation'] },
  { pattern: /(?:^|[/\\])(?:gc|gamecube|wii)(?:[/\\]|$)/i, candidates: ['dolphin-emu'] },
  { pattern: /(?:^|[/\\])psp(?:[/\\]|$)/i, candidates: ['ppsspp', 'PPSSPPSDL'] },
];

/** True when `name` resolves to an executable on PATH. */
export function isCommandAvailable(name: string): boolean {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const accessMode = process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK;
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      try {
        fs.accessSync(path.join(dir, name + extension), accessMode);
        return true;
      } catch {
        // Keep looking through PATH.
      }
    }
  }
  return false;
}

export function detectInstalledEmulators(): Set<string> {
  const candidates = new Set<string>();
  for (const names of Object.values(EMULATOR_CANDIDATES)) {
    for (const name of names) candidates.add(name);
  }
  return new Set(Array.from(candidates).filter(isCommandAvailable));
}

/** Pick an installed emulator for a ROM, or fall back to RetroArch. */
export function getEmulatorForRom(
  filePath: string,
  available: Set<string> = detectInstalledEmulators(),
): string | null {
  const hinted = PLATFORM_HINTS.find((hint) => hint.pattern.test(filePath))?.candidates ?? [];
  const byExtension = EMULATOR_CANDIDATES[path.extname(filePath).toLowerCase()] ?? [];
  const candidates = new Set([...hinted, ...byExtension, 'retroarch']);
  for (const name of candidates) {
    if (available.has(name)) return name;
  }
  return null;
}

export function isRomFile(filePath: string): boolean {
  return ROM_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function scanRomFolder(
  folder: string,
  recursive = true,
  installedEmulators?: Set<string>,
): Game[] {
  const games: Game[] = [];
  if (!fs.existsSync(folder)) return games;
  const availableEmulators = installedEmulators ?? detectInstalledEmulators();
  const retroarchConfigDir = getRetroArchConfigDir();

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
        const emulator = getEmulatorForRom(fullPath, availableEmulators);
        const savePath = emulator === 'retroarch'
          ? getRetroArchSavePath(fullPath, retroarchConfigDir)
          : null;
        games.push({
          id: nextId(),
          name: path.basename(fullPath, path.extname(fullPath)),
          winPath: '',
          // RetroArch battery saves can sync per-ROM. Other emulator save
          // layouts stay unmapped until their save root is discovered.
          linPath: savePath ?? '',
          lastSync: 'Never',
          status: 'Pending Upload',
          thumbnail: '',
          source: 'emulator',
          sourceId: 'emulator',
          romPath: fullPath,
          ...(emulator ? { emulator } : {}),
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
