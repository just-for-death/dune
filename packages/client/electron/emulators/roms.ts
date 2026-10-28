import * as fs from 'fs';
import * as path from 'path';
import { nextId } from '@dune/shared';
import type { Game } from '@dune/shared';
import * as os from 'os';

const ROM_EXTENSIONS = new Set([
  '.nes', '.snes', '.smc', '.sfc', '.n64', '.z64', '.v64', '.gb', '.gbc', '.gba',
  '.nds', '.3ds', '.cso', '.iso', '.bin', '.cue', '.chd', '.wbfs', '.gcm', '.rvz',
  '.md', '.gen', '.smd', '.sms', '.gg', '.pce', '.ws', '.wsc', '.a26', '.lnx',
  '.gdi', '.m3u',
]);

/**
 * DUN-083: descriptor files that list the real data files of one game. The
 * descriptor is the game; the files it lists are not separate games.
 */
const DISC_DESCRIPTORS = new Set(['.cue', '.gdi', '.m3u']);
const MAX_DESCRIPTOR_BYTES = 1024 * 1024;

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
  '.gdi': ['retroarch'],
  '.m3u': ['duckstation-qt', 'duckstation', 'pcsx2', 'retroarch'],
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

/** Files a .cue/.gdi/.m3u descriptor refers to, resolved next to the descriptor. */
export function getDescriptorReferences(descriptorPath: string): string[] {
  const ext = path.extname(descriptorPath).toLowerCase();
  if (!DISC_DESCRIPTORS.has(ext)) return [];
  let text: string;
  try {
    if (fs.statSync(descriptorPath).size > MAX_DESCRIPTOR_BYTES) return [];
    text = fs.readFileSync(descriptorPath, 'utf8');
  } catch {
    return [];
  }
  const dir = path.dirname(descriptorPath);
  const refs: string[] = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    let name: string | undefined;
    if (ext === '.cue') {
      // FILE "Track 01.bin" BINARY  |  FILE track.bin BINARY
      const m = /^FILE\s+(?:"([^"]+)"|(\S+))/i.exec(line);
      name = m?.[1] ?? m?.[2];
    } else if (ext === '.gdi') {
      // First line is the track count; then: <n> <lba> <type> <size> <file> <offset>
      if (index === 0) return;
      const m = /^\d+\s+\d+\s+\d+\s+\d+\s+(?:"([^"]+)"|(\S+))/.exec(line);
      name = m?.[1] ?? m?.[2];
    } else if (!line.startsWith('#')) {
      name = line;
    }
    if (name) refs.push(path.resolve(dir, name.replace(/\\/g, '/')));
  });
  return refs;
}

function existingDir(candidate: string | undefined): string | null {
  if (!candidate) return null;
  try {
    return fs.statSync(candidate).isDirectory() ? candidate : null;
  } catch {
    return null;
  }
}

function expandHome(value: string): string {
  return value === '~' || value.startsWith('~/') || value.startsWith('~\\') ? path.join(os.homedir(), value.slice(1)) : value;
}

/**
 * DUN-083: every RetroArch battery-save folder to look in, in order: for each
 * existing config dir (RETROARCH_CONFIG_DIR entries, or the native, Flatpak,
 * Windows and macOS defaults), the savefile_directory set in its
 * retroarch.cfg, then its default `saves` folder.
 */
export function getRetroArchSaveDirs(): string[] {
  const home = os.homedir();
  const env = process.env.RETROARCH_CONFIG_DIR;
  const configDirs = env
    ? env.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean)
    : [
      path.join(home, '.config', 'retroarch'),
      path.join(home, '.var', 'app', 'org.libretro.RetroArch', 'config', 'retroarch'),
      ...(process.env.APPDATA ? [path.join(process.env.APPDATA, 'RetroArch')] : []),
      path.join(home, 'Library', 'Application Support', 'RetroArch'),
    ];
  const dirs: string[] = [];
  for (const candidate of configDirs) {
    const configDir = existingDir(candidate);
    if (!configDir) continue;
    try {
      const cfg = fs.readFileSync(path.join(configDir, 'retroarch.cfg'), 'utf8');
      const m = /^\s*savefile_directory\s*=\s*"?([^"\r\n]*)"?\s*$/m.exec(cfg);
      const value = m?.[1]?.trim();
      if (value && value !== 'default') {
        // ":" means "relative to the config dir" in RetroArch paths.
        const resolved = value.startsWith(':') ? path.join(configDir, value.slice(1)) : expandHome(value);
        dirs.push(path.resolve(configDir, resolved));
      }
    } catch {
      // No retroarch.cfg: RetroArch uses <config>/saves.
    }
    dirs.push(path.join(configDir, 'saves'));
  }
  return Array.from(new Set(dirs));
}

/**
 * The battery save for a ROM: an existing `<name>.srm`/`.sav` in any of the
 * save dirs, else the default `.srm` path in the first one (so sync picks it
 * up once the game creates it). Null when RetroArch is not configured.
 */
export function findRetroArchSavePath(romPath: string, saveDirs: string[] = getRetroArchSaveDirs()): string | null {
  if (saveDirs.length === 0) return null;
  const base = path.basename(romPath, path.extname(romPath));
  for (const dir of saveDirs) {
    for (const extension of ['.srm', '.sav']) {
      const candidate = path.join(dir, base + extension);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return path.join(saveDirs[0], base + '.srm');
}

export function scanRomFolder(
  folder: string,
  recursive = true,
  installedEmulators?: Set<string>,
  platform: NodeJS.Platform = process.platform,
): Game[] {
  const games: Game[] = [];
  if (!fs.existsSync(folder)) return games;
  const availableEmulators = installedEmulators ?? detectInstalledEmulators();

  const romFiles: string[] = [];
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
        romFiles.push(fullPath);
      }
    }
  };
  walk(folder);

  // DUN-083: a multi-file disc is one game, named after its descriptor. Files
  // a descriptor lists (.bin tracks, or the .cue/.chd discs of an .m3u) are
  // not games of their own. An .m3u never hides another .m3u (no cycles).
  const sameFile = (p: string) => (platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p);
  const referenced = new Set<string>();
  for (const file of romFiles) {
    const isPlaylist = path.extname(file).toLowerCase() === '.m3u';
    for (const ref of getDescriptorReferences(file)) {
      if (isPlaylist && path.extname(ref).toLowerCase() === '.m3u') continue;
      if (sameFile(ref) !== sameFile(file)) referenced.add(sameFile(ref));
    }
  }

  const saveDirs = getRetroArchSaveDirs();
  for (const fullPath of romFiles) {
    if (referenced.has(sameFile(fullPath))) continue;
    const now = new Date().toISOString();
    const emulator = getEmulatorForRom(fullPath, availableEmulators);
    const savePath = emulator === 'retroarch' ? findRetroArchSavePath(fullPath, saveDirs) : null;
    games.push({
      id: nextId(),
      name: path.basename(fullPath, path.extname(fullPath)),
      // RetroArch battery saves sync per ROM. The save path goes in this
      // platform's field (winPath on Windows, linPath elsewhere), which is
      // the one save sync reads. Other emulator save layouts stay unmapped
      // until their save root is discovered.
      winPath: platform === 'win32' ? savePath ?? '' : '',
      linPath: platform === 'win32' ? '' : savePath ?? '',
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
