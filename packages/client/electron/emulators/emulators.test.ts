import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { detectEmulators, getRetroArchConfigDir } from './detect.js';
import { scanRomFolder, isRomFile, getEmulatorForRom, getDescriptorReferences, getRetroArchSaveDirs, findRetroArchSavePath } from './roms.js';
import { getRetroArchSaveStates, getRetroArchBatterySaves, getRetroArchSavePath, findFilesByExtensions } from './saves.js';

describe('emulator support', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    delete process.env.RETROARCH_CONFIG_DIR;
    delete process.env.EMULATOR_ROM_ROOTS;
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.RETROARCH_CONFIG_DIR;
    delete process.env.EMULATOR_ROM_ROOTS;
  });

  it('detects RetroArch from config directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-ra-'));
    tempDirs.push(dir);
    process.env.RETROARCH_CONFIG_DIR = dir;
    expect(getRetroArchConfigDir()).toBe(dir);
    expect(detectEmulators().some((e) => e.type === 'retroarch')).toBe(true);
  });

  it('scans ROM files recursively', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-roms-'));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, 'nes'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'nes', 'mario.nes'), 'rom');
    const retroarch = path.join(dir, 'retroarch');
    fs.mkdirSync(path.join(retroarch, 'saves'), { recursive: true });
    fs.writeFileSync(path.join(retroarch, 'saves', 'mario.sav'), 'save');
    process.env.RETROARCH_CONFIG_DIR = retroarch;
    const games = scanRomFolder(dir, true, new Set(['retroarch']));
    expect(games).toHaveLength(1);
    expect(games[0].name).toBe('mario');
    expect(games[0].source).toBe('emulator');
    expect(games[0].romPath).toBe(path.join(dir, 'nes', 'mario.nes'));
    expect(games[0].linPath).toBe(path.join(retroarch, 'saves', 'mario.sav'));
    expect(games[0].emulator).toBe('retroarch');
    expect(isRomFile('mario.nes')).toBe(true);
  });

  it('finds RetroArch save states and battery saves', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-ra-saves-'));
    tempDirs.push(dir);
    const states = path.join(dir, 'states');
    const saves = path.join(dir, 'saves');
    fs.mkdirSync(states, { recursive: true });
    fs.mkdirSync(saves, { recursive: true });
    fs.writeFileSync(path.join(states, 'game.state'), 'state');
    fs.writeFileSync(path.join(saves, 'game.srm'), 'save');
    expect(getRetroArchSaveStates(dir)).toHaveLength(1);
    expect(getRetroArchBatterySaves(dir)).toHaveLength(1);
    expect(findFilesByExtensions(dir, ['.state'])).toHaveLength(1);
  });

  it('picks an installed emulator by ROM extension', () => {
    expect(getEmulatorForRom('/games/mario.nes', new Set(['mesen', 'retroarch']))).toBe('retroarch');
    expect(getEmulatorForRom('/games/mario.nes', new Set(['mesen']))).toBe('mesen');
    expect(getEmulatorForRom('/games/wii.wbfs', new Set(['retroarch', 'dolphin-emu']))).toBe('dolphin-emu');
    expect(getEmulatorForRom('/games/psp.cso', new Set(['retroarch', 'ppsspp']))).toBe('ppsspp');
    expect(getEmulatorForRom('/games/PS2/game.iso', new Set(['retroarch', 'duckstation', 'pcsx2']))).toBe('pcsx2');
    expect(getEmulatorForRom('/games/unknown.xyz', new Set(['retroarch']))).toBe('retroarch');
    expect(getEmulatorForRom('/games/mario.nes', new Set())).toBeNull();
  });

  it('maps RetroArch battery saves without treating the ROM as a save', () => {
    const config = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-ra-map-'));
    tempDirs.push(config);
    const saves = path.join(config, 'saves');
    fs.mkdirSync(saves, { recursive: true });

    expect(getRetroArchSavePath('/roms/mario.nes', config)).toBe(path.join(saves, 'mario.srm'));
    fs.writeFileSync(path.join(saves, 'mario.sav'), 'save');
    expect(getRetroArchSavePath('/roms/mario.nes', config)).toBe(path.join(saves, 'mario.sav'));
    expect(getRetroArchSavePath('/roms/mario.nes', null)).toBeNull();
  });

  describe('multi-file discs and save lookup (DUN-083)', () => {
    const tmp = () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-dun083-'));
      tempDirs.push(dir);
      return dir;
    };
    const write = (file: string, body = 'x') => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
    };
    const names = (games: { name: string }[]) => games.map((g) => g.name).sort();
    // Never look at the real ~/.config/retroarch: every test gets a temp config dir.
    beforeEach(() => { process.env.RETROARCH_CONFIG_DIR = tmp(); });

    it('treats a .cue and its .bin tracks as one game, keeping loose .bin files', () => {
      const roms = tmp();
      write(path.join(roms, 'psx', 'Crash.cue'), 'FILE "Crash (Track 1).bin" BINARY\r\n  TRACK 01 MODE2/2352\r\nFILE Crash_2.bin BINARY\r\n');
      write(path.join(roms, 'psx', 'Crash (Track 1).bin'));
      write(path.join(roms, 'psx', 'Crash_2.bin'));
      write(path.join(roms, 'psx', 'Loose.bin'));
      const games = scanRomFolder(roms, true, new Set(['retroarch']), 'linux');
      expect(names(games)).toEqual(['Crash', 'Loose']);
      expect(games.find((g) => g.name === 'Crash')?.romPath).toBe(path.join(roms, 'psx', 'Crash.cue'));
    });

    it('groups a multi-disc .m3u (discs in a subfolder) under the playlist', () => {
      const roms = tmp();
      write(path.join(roms, 'FF7.m3u'), '#EXTM3U\n.discs/FF7 (Disc 1).cue\n.discs\\FF7 (Disc 2).cue\nFF7.m3u\n');
      for (const n of [1, 2]) {
        write(path.join(roms, '.discs', `FF7 (Disc ${n}).cue`), `FILE "FF7 (Disc ${n}).bin" BINARY\n`);
        write(path.join(roms, '.discs', `FF7 (Disc ${n}).bin`));
      }
      const games = scanRomFolder(roms, true, new Set(['retroarch']), 'linux');
      expect(names(games)).toEqual(['FF7']);
      expect(games[0].romPath).toBe(path.join(roms, 'FF7.m3u'));
    });

    it('groups a .gdi with quoted and unquoted track files', () => {
      const roms = tmp();
      write(path.join(roms, 'dc', 'Shenmue.gdi'), '3\n1 0 4 2352 track01.bin 0\n2 600 0 2352 "track 02.raw" 0\n3 45000 4 2352 track03.bin 0\n');
      write(path.join(roms, 'dc', 'track01.bin'));
      write(path.join(roms, 'dc', 'track03.bin'));
      expect(getDescriptorReferences(path.join(roms, 'dc', 'Shenmue.gdi'))).toEqual(
        ['track01.bin', 'track 02.raw', 'track03.bin'].map((f) => path.join(roms, 'dc', f)));
      expect(names(scanRomFolder(roms, true, new Set(['retroarch']), 'linux'))).toEqual(['Shenmue']);
    });

    it('puts the save path in the platform field (winPath on Windows, linPath elsewhere)', () => {
      const roms = tmp();
      const ra = tmp();
      write(path.join(roms, 'zelda.sfc'));
      write(path.join(ra, 'saves', 'zelda.srm'));
      process.env.RETROARCH_CONFIG_DIR = ra;
      const [win] = scanRomFolder(roms, true, new Set(['retroarch']), 'win32');
      expect(win.winPath).toBe(path.join(ra, 'saves', 'zelda.srm'));
      expect(win.linPath).toBe('');
      const [lin] = scanRomFolder(roms, true, new Set(['retroarch']), 'linux');
      expect(lin.linPath).toBe(path.join(ra, 'saves', 'zelda.srm'));
      expect(lin.winPath).toBe('');
    });

    it('looks for saves in every configured RetroArch dir, honouring savefile_directory', () => {
      const a = tmp();
      const b = tmp();
      const custom = tmp();
      write(path.join(a, 'retroarch.cfg'), `video_driver = "gl"\nsavefile_directory = "${custom}"\n`);
      write(path.join(b, 'retroarch.cfg'), 'savefile_directory = ":/mysaves"\n');
      process.env.RETROARCH_CONFIG_DIR = [a, path.join(a, 'missing'), b].join(path.delimiter);
      expect(getRetroArchSaveDirs()).toEqual([custom, path.join(a, 'saves'), path.join(b, 'mysaves'), path.join(b, 'saves')]);

      write(path.join(b, 'mysaves', 'metroid.sav'));
      expect(findRetroArchSavePath('/roms/metroid.gba')).toBe(path.join(b, 'mysaves', 'metroid.sav'));
      write(path.join(custom, 'kirby.srm'));
      expect(findRetroArchSavePath('/roms/kirby.gba')).toBe(path.join(custom, 'kirby.srm'));
      // Nothing yet: the default .srm in the first save dir.
      expect(findRetroArchSavePath('/roms/new.gba')).toBe(path.join(custom, 'new.srm'));
      expect(findRetroArchSavePath('/roms/new.gba', [])).toBeNull();
    });
  });
});
