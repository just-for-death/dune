import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * DUN-075: RetroArch needs `-L <core>`; without it, it opens its menu and the
 * menu time counted as playtime. Each ROM extension maps to libretro cores
 * in preference order; the first one installed in a known cores folder is
 * used. No installed core (or an extension with no core mapping) means the
 * game is refused with a clear message.
 */
export const RETROARCH_CORES: Record<string, readonly string[]> = {
  '.nes': ['mesen', 'nestopia', 'fceumm'],
  '.snes': ['snes9x', 'bsnes'],
  '.smc': ['snes9x', 'bsnes'],
  '.sfc': ['snes9x', 'bsnes'],
  '.n64': ['mupen64plus_next', 'parallel_n64'],
  '.z64': ['mupen64plus_next', 'parallel_n64'],
  '.v64': ['mupen64plus_next', 'parallel_n64'],
  '.gb': ['gambatte', 'sameboy', 'mgba'],
  '.gbc': ['gambatte', 'sameboy', 'mgba'],
  '.gba': ['mgba', 'vba_next'],
  '.nds': ['melonds', 'desmume'],
  '.cso': ['ppsspp'],
  '.cue': ['swanstation', 'mednafen_psx_hw', 'pcsx_rearmed'],
  '.chd': ['swanstation', 'mednafen_psx_hw', 'pcsx_rearmed'],
  '.wbfs': ['dolphin'],
  '.gcm': ['dolphin'],
  '.rvz': ['dolphin'],
  '.md': ['genesis_plus_gx', 'picodrive'],
  '.gen': ['genesis_plus_gx', 'picodrive'],
  '.smd': ['genesis_plus_gx', 'picodrive'],
  '.sms': ['genesis_plus_gx', 'picodrive'],
  '.gg': ['genesis_plus_gx'],
  '.pce': ['mednafen_pce_fast', 'mednafen_pce'],
  '.ws': ['mednafen_wswan'],
  '.wsc': ['mednafen_wswan'],
  '.a26': ['stella'],
  '.lnx': ['handy', 'mednafen_lynx'],
};

export interface CoreLookupDeps {
  platform: NodeJS.Platform;
  dirs: readonly string[];
  isFile: (p: string) => boolean;
}

export function coreFileName(core: string, platform: NodeJS.Platform): string {
  const ext = platform === 'win32' ? 'dll' : platform === 'darwin' ? 'dylib' : 'so';
  return `${core}_libretro.${ext}`;
}

/** Folders RetroArch installs cores into, per platform (RETROARCH_CORES_DIR first when set). */
export function defaultCoreDirs(platform: NodeJS.Platform = process.platform, home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs: string[] = [];
  if (env.RETROARCH_CORES_DIR) dirs.push(env.RETROARCH_CORES_DIR);
  if (platform === 'win32') {
    if (env.APPDATA) dirs.push(path.win32.join(env.APPDATA, 'RetroArch', 'cores'));
    dirs.push('C:\\RetroArch-Win64\\cores', 'C:\\RetroArch\\cores');
  } else if (platform === 'darwin') {
    dirs.push(path.posix.join(home, 'Library', 'Application Support', 'RetroArch', 'cores'));
  } else {
    dirs.push(
      path.posix.join(home, '.config', 'retroarch', 'cores'),
      path.posix.join(home, '.var', 'app', 'org.libretro.RetroArch', 'config', 'retroarch', 'cores'),
      '/usr/lib/libretro',
      '/usr/lib/x86_64-linux-gnu/libretro',
      '/usr/lib64/libretro',
      '/usr/local/lib/libretro',
    );
  }
  return dirs;
}

function defaultIsFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

export function defaultCoreLookupDeps(): CoreLookupDeps {
  return { platform: process.platform, dirs: defaultCoreDirs(), isFile: defaultIsFile };
}

export type CoreLookup = { ok: true; core: string } | { ok: false; message: string };

export function findRetroArchCore(romPath: string, deps: CoreLookupDeps = defaultCoreLookupDeps()): CoreLookup {
  const ext = path.extname(romPath).toLowerCase();
  const cores = RETROARCH_CORES[ext];
  if (!cores || cores.length === 0) {
    return { ok: false, message: `RetroArch has no known core for ${ext || 'this'} ROMs. Pick another emulator for this game.` };
  }
  const api = deps.platform === 'win32' ? path.win32 : path.posix;
  for (const core of cores) {
    for (const dir of deps.dirs) {
      const candidate = api.join(dir, coreFileName(core, deps.platform));
      if (deps.isFile(candidate)) return { ok: true, core: candidate };
    }
  }
  return {
    ok: false,
    message: `No RetroArch core installed for ${ext} ROMs. Install one of: ${cores.join(', ')} (Online Updater > Core Downloader).`,
  };
}
