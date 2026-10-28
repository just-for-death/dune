import { describe, it, expect } from 'vitest';
import { coreFileName, defaultCoreDirs, findRetroArchCore } from './retroarchCores';

const deps = (installed: string[], platform: NodeJS.Platform = 'linux') => {
  const dir = platform === 'win32' ? 'C:\\RA\\cores' : '/ra/cores';
  const files = new Set(installed.map((c) => (platform === 'win32' ? `${dir}\\${coreFileName(c, platform)}` : `${dir}/${coreFileName(c, platform)}`)));
  return { platform, dirs: [dir], isFile: (p: string) => files.has(p) };
};

describe('RetroArch cores (DUN-075)', () => {
  it('picks the first installed core for the ROM extension (case-insensitive)', () => {
    expect(findRetroArchCore('/roms/Game.SFC', deps(['bsnes']))).toEqual({ ok: true, core: '/ra/cores/bsnes_libretro.so' });
    expect(findRetroArchCore('/roms/a.gba', deps(['vba_next', 'mgba']))).toEqual({ ok: true, core: '/ra/cores/mgba_libretro.so' });
    expect(findRetroArchCore('C:\\roms\\a.nes', deps(['fceumm'], 'win32'))).toEqual({ ok: true, core: 'C:\\RA\\cores\\fceumm_libretro.dll' });
    expect(coreFileName('mgba', 'darwin')).toBe('mgba_libretro.dylib');
  });

  it('refuses with a clear message when no core is installed or the extension has no core', () => {
    const none = findRetroArchCore('/roms/a.n64', deps([]));
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.message).toMatch(/mupen64plus_next/);
    const iso = findRetroArchCore('/roms/a.iso', deps(['swanstation']));
    expect(iso.ok).toBe(false);
    if (!iso.ok) expect(iso.message).toMatch(/no known core for \.iso/);
  });

  it('default core folders per platform; RETROARCH_CORES_DIR comes first', () => {
    expect(defaultCoreDirs('linux', '/home/u', { RETROARCH_CORES_DIR: '/x' })[0]).toBe('/x');
    expect(defaultCoreDirs('linux', '/home/u', {})).toContain('/home/u/.config/retroarch/cores');
    expect(defaultCoreDirs('darwin', '/Users/u', {})).toEqual(['/Users/u/Library/Application Support/RetroArch/cores']);
    expect(defaultCoreDirs('win32', 'C:\\Users\\u', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' })[0]).toBe('C:\\Users\\u\\AppData\\Roaming\\RetroArch\\cores');
  });
});
