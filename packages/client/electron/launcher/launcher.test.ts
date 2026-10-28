import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChildProcess } from 'child_process';
import type { Game } from '@dune/shared';
import { getLaunchCommand as getLaunchPlan, getLaunchRefusal, launchGame, selectLaunchStrategy, type SpawnFn } from './manager.js';
import type { LaunchCommand, LaunchOptions, LaunchUrl } from './strategies/types.js';
import type { CoreLookupDeps } from './retroarchCores.js';

// Test view of a launch plan: spawn fields, or `url` for URL launches (DUN-074).
function getLaunchCommand(game: Game, options?: LaunchOptions): (LaunchCommand & Partial<LaunchUrl>) | null {
  return getLaunchPlan(game, options) as (LaunchCommand & Partial<LaunchUrl>) | null;
}

// DUN-075: a fake RetroArch cores folder (nothing on the real disk is read).
function fakeCores(installed: string[]): CoreLookupDeps {
  const dir = '/fake/retroarch/cores';
  const files = new Set(installed.map((c) => path.posix.join(dir, `${c}_libretro.so`)));
  return { platform: 'linux', dirs: [dir], isFile: (p) => files.has(p) };
}

// DUN-031: every file this suite writes lives in a mkdtemp folder that is
// removed afterwards (suite-wide fixtures in afterAll, per-test files in
// afterEach). Nothing is executed: launches go through a fake spawn.
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dune061-launch-'));
const tempFile = path.join(fixtureDir, 'dune-launch-test.sh');
fs.writeFileSync(tempFile, '#!/bin/sh\n');

// linPath/winPath are SAVE paths; launchers must use executable/installPath.
const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dune061-launch-saves-'));
const saveFile = path.join(saveDir, 'slot1.sav');
fs.writeFileSync(saveFile, 'save');

const perTestDirs: string[] = [];
function testDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dune061-launch-case-'));
  perTestDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of perTestDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
afterAll(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  fs.rmSync(saveDir, { recursive: true, force: true });
});

/** Fake spawn: emits `spawn` then `exit` (or ENOENT `error`). */
function fakeSpawn(mode: 'exit' | 'enoent' = 'exit') {
  const calls: { command: string; args: readonly string[] }[] = [];
  const spawn: SpawnFn = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter() as EventEmitter & { pid?: number; unref: () => void };
    child.pid = 77;
    child.unref = () => {};
    setImmediate(() => {
      if (mode === 'enoent') {
        child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
        return;
      }
      child.emit('spawn');
      setImmediate(() => child.emit('exit', 0));
    });
    return child as unknown as ChildProcess;
  };
  return { spawn, calls };
}

const baseGame: Game = {
  id: 1,
  name: 'Test Game',
  winPath: '',
  linPath: saveDir,
  executable: tempFile,
  lastSync: 'Never',
  status: 'In Sync',
  thumbnail: '',
  createdAt: '',
  updatedAt: '',
};

describe('launcher strategies', () => {
  it('selects native strategy for executable paths', () => {
    const command = getLaunchCommand(baseGame);
    expect(command?.command).toBe(tempFile);
  });

  it('opens Steam through the OS URL handler, not xdg-open (DUN-074)', () => {
    const game = { ...baseGame, source: 'steam' as const };
    expect(getLaunchPlan(game, { appId: '12345' })).toEqual({ url: 'steam://rungameid/12345' });
  });

  it('launches a Steam URL with openExternal and never spawns (DUN-074)', async () => {
    const game = { ...baseGame, source: 'steam' as const, steamAppId: '620' };
    const opened: string[] = [];
    const fake = fakeSpawn();
    const result = await launchGame(game, {}, { spawn: fake.spawn, openExternal: async (url) => { opened.push(url); } });
    expect(result).toEqual({ success: true, message: 'Launched' });
    expect(opened).toEqual(['steam://rungameid/620']);
    expect(fake.calls).toEqual([]);
    const failed = await launchGame(game, {}, { openExternal: async () => { throw new Error('no handler'); } });
    expect(failed).toEqual({ success: false, message: 'no handler' });
  });

  it('falls back to a native executable for non-manual sources', () => {
    const game = { ...baseGame, source: 'epic' as const };
    expect(getLaunchCommand(game)?.command).toBe(tempFile);
  });

  it('uses scanner metadata when launch options are omitted', () => {
    const steamGame = { ...baseGame, sourceId: 'steam', steamAppId: '67890' };
    expect(getLaunchCommand(steamGame)?.url).toBe('steam://rungameid/67890');

    const heroicGame = { ...baseGame, sourceId: 'heroic', heroicId: 'heroic-game-id' };
    expect(getLaunchCommand(heroicGame)?.args).toEqual(['--run', 'heroic-game-id']);

    const lutrisGame = { ...baseGame, sourceId: 'lutris', lutrisSlug: 'my-game' };
    expect(getLaunchCommand(lutrisGame)?.args).toEqual(['lutris:rungame/my-game']);
  });

  it('generates Heroic command', () => {
    const game = { ...baseGame, source: 'heroic' as const };
    const command = getLaunchCommand(game, { heroicId: 'heroic-game-id' });
    expect(command?.command).toBe('heroic');
    expect(command?.args).toEqual(['--run', 'heroic-game-id']);
  });

  it('generates Lutris command', () => {
    const game = { ...baseGame, source: 'lutris' as const };
    const command = getLaunchCommand(game, { lutrisSlug: 'my-game' });
    expect(command?.command).toBe('lutris');
    expect(command?.args).toEqual(['lutris:rungame/my-game']);
  });

  it('generates Wine command with prefix', () => {
    const command = getLaunchCommand(baseGame, { winePrefix: '/tmp/prefix' });
    expect(command?.command).toBe('wine');
    expect(command?.env?.WINEPREFIX).toBe('/tmp/prefix');
  });

  it('returns null when no strategy matches', () => {
    const game = { ...baseGame, executable: '/games/does-not-exist.sh' };
    expect(getLaunchCommand(game, {})).toBeNull();
    expect(selectLaunchStrategy(game, {})).toBeNull();
  });

  it('reports process exit for playtime tracking', async () => {
    const script = path.join(testDir(), 'dune-launch-exit.sh');
    fs.writeFileSync(script, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const game = { ...baseGame, executable: script };
    const fake = fakeSpawn();
    const exited = new Promise<{ startedAt: number; endedAt: number }>((resolve) => {
      void launchGame(game, {}, { onExit: resolve, spawn: fake.spawn }).then((result) => {
        expect(result.success).toBe(true);
      });
    });
    const info = await exited;
    expect(info.endedAt).toBeGreaterThanOrEqual(info.startedAt);
    expect(fake.calls).toEqual([{ command: script, args: [] }]);
  });

  it('launches a ROM through a known emulator', async () => {
    const rom = path.join(testDir(), 'dune-launch-rom.nes');
    fs.writeFileSync(rom, 'rom');
    const game = { ...baseGame, source: 'emulator' as const, linPath: '', romPath: rom, emulator: 'retroarch' };
    const coreLookup = fakeCores(['nestopia', 'mesen']);
    const core = '/fake/retroarch/cores/mesen_libretro.so';

    expect(getLaunchCommand(game, { coreLookup })?.command).toBe('retroarch');
    // DUN-075: always with -L <core>, so RetroArch never opens its menu.
    expect(getLaunchCommand(game, { coreLookup })?.args).toEqual(['-L', core, rom]);

    const fake = fakeSpawn();
    const exited = new Promise<{ startedAt: number; endedAt: number }>((resolve) => {
      void launchGame(game, { coreLookup }, { onExit: resolve, spawn: fake.spawn }).then((result) => {
        expect(result.success).toBe(true);
      });
    });
    const info = await exited;
    expect(info.endedAt).toBeGreaterThanOrEqual(info.startedAt);
    expect(fake.calls).toEqual([{ command: 'retroarch', args: ['-L', core, rom] }]);
  });

  it('refuses RetroArch with a clear message when no core is installed (DUN-075)', async () => {
    const rom = path.join(testDir(), 'game.gba');
    fs.writeFileSync(rom, 'rom');
    const game = { ...baseGame, executable: undefined, source: 'emulator' as const, linPath: '', romPath: rom, emulator: 'retroarch' };
    const coreLookup = fakeCores([]);
    expect(getLaunchCommand(game, { coreLookup })).toBeNull();
    expect(getLaunchRefusal(game, { coreLookup })).toMatch(/No RetroArch core installed for \.gba ROMs.*mgba/);
    const fake = fakeSpawn();
    const result = await launchGame(game, { coreLookup }, { spawn: fake.spawn });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/No RetroArch core/);
    expect(fake.calls).toEqual([]);
    // Another emulator for the same ROM is not affected.
    expect(getLaunchRefusal({ ...game, emulator: 'mgba-qt' }, { coreLookup })).toBeNull();
  });

  it('never runs an emulator that is not on the known list (DUN-061)', () => {
    const dir = testDir();
    const rom = path.join(dir, 'dune-launch-rom.nes');
    const script = path.join(dir, 'evil.sh');
    fs.writeFileSync(rom, 'rom');
    fs.writeFileSync(script, '#!/bin/sh\n', { mode: 0o755 });
    for (const emulator of [script, '/bin/sh', 'bash', 'retroarch --verbose', '../retroarch']) {
      const game = { ...baseGame, executable: undefined, source: 'emulator' as const, linPath: '', romPath: rom, emulator };
      expect(getLaunchCommand(game)).toBeNull();
    }
  });

  it('reports a missing emulator command instead of claiming success', async () => {
    const rom = path.join(testDir(), 'dune-launch-missing-rom.nes');
    fs.writeFileSync(rom, 'rom');
    const game = {
      ...baseGame,
      source: 'emulator' as const,
      linPath: '',
      romPath: rom,
      emulator: 'duckstation',
    };
    const result = await launchGame(game, {}, { spawn: fakeSpawn('enoent').spawn });
    expect(result.success).toBe(false);
    expect(result.message).toContain('Command not found');
  });
  it('never launches a save path from linPath/winPath', () => {
    const game = { ...baseGame, executable: undefined, linPath: saveFile, winPath: saveFile };
    expect(getLaunchCommand(game)).toBeNull();
    expect(getLaunchCommand(game, { winePrefix: '/tmp/prefix' })).toBeNull();
  });

  it('does not spawn an install folder, but uses an executable inside it', () => {
    const installDir = testDir();
    const folderOnly = { ...baseGame, executable: undefined, installPath: installDir };
    expect(getLaunchCommand(folderOnly)).toBeNull();
    expect(getLaunchCommand(folderOnly, { winePrefix: '/tmp/prefix' })).toBeNull();

    fs.writeFileSync(path.join(installDir, 'game.sh'), '#!/bin/sh\n');
    const relative = { ...folderOnly, executable: 'game.sh' };
    expect(getLaunchCommand(relative)?.command).toBe(path.join(installDir, 'game.sh'));

    fs.writeFileSync(path.join(installDir, 'Game.exe'), '');
    const wine = getLaunchCommand({ ...folderOnly, executable: 'Game.exe', winePrefix: '/tmp/prefix' });
    expect(wine?.command).toBe('wine');
    expect(wine?.args).toEqual([path.join(installDir, 'Game.exe')]);
    expect(wine?.cwd).toBe(installDir);
  });

  it('accepts installPath when it points at an executable file', () => {
    const game = { ...baseGame, executable: undefined, installPath: tempFile };
    expect(getLaunchCommand(game)?.command).toBe(tempFile);
  });

  it('still prefers store launchers over a native executable', () => {
    const steam = { ...baseGame, source: 'steam' as const, steamAppId: '620', installPath: saveDir };
    expect(getLaunchCommand(steam)).toEqual({ url: 'steam://rungameid/620' });
  });
});
