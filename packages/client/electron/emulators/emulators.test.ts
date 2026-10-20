import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { detectEmulators, getRetroArchConfigDir } from './detect.js';
import { scanRomFolder, isRomFile, getEmulatorForRom } from './roms.js';
import { getRetroArchSaveStates, getRetroArchBatterySaves, findFilesByExtensions } from './saves.js';

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
    const games = scanRomFolder(dir);
    expect(games).toHaveLength(1);
    expect(games[0].name).toBe('mario');
    expect(games[0].source).toBe('emulator');
    expect(games[0].romPath).toBe(path.join(dir, 'nes', 'mario.nes'));
    expect(games[0].linPath).toBe('');
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
});
