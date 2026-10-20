import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Game } from '@dune/shared';
import { getLaunchCommand, launchGame, selectLaunchStrategy } from './manager.js';

const tempFile = path.join(os.tmpdir(), 'dune-launch-test.sh');
fs.writeFileSync(tempFile, '#!/bin/sh\n');

const baseGame: Game = {
  id: 1,
  name: 'Test Game',
  winPath: '',
  linPath: tempFile,
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

  it('generates Steam protocol command', () => {
    const game = { ...baseGame, source: 'steam' as const };
    const command = getLaunchCommand(game, { appId: '12345' });
    expect(command?.command).toBe('xdg-open');
    expect(command?.args[0]).toBe('steam://run/12345');
  });

  it('falls back to a native executable for non-manual sources', () => {
    const game = { ...baseGame, source: 'epic' as const };
    expect(getLaunchCommand(game)?.command).toBe(tempFile);
  });

  it('uses scanner metadata when launch options are omitted', () => {
    const steamGame = { ...baseGame, sourceId: 'steam', steamAppId: '67890' };
    expect(getLaunchCommand(steamGame)?.args[0]).toBe('steam://run/67890');

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
    const game = { ...baseGame, linPath: '/games/does-not-exist.sh' };
    expect(getLaunchCommand(game, {})).toBeNull();
    expect(selectLaunchStrategy(game, {})).toBeNull();
  });

  it('reports process exit for playtime tracking', async () => {
    const script = path.join(os.tmpdir(), `dune-launch-exit-${Date.now()}.sh`);
    fs.writeFileSync(script, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const game = { ...baseGame, linPath: script };
    const exited = new Promise<{ startedAt: number; endedAt: number }>((resolve) => {
      void launchGame(game, {}, { onExit: resolve }).then((result) => {
        expect(result.success).toBe(true);
      });
    });
    const info = await exited;
    expect(info.endedAt).toBeGreaterThanOrEqual(info.startedAt);
  });

  it('launches a ROM through its detected emulator', async () => {
    const script = path.join(os.tmpdir(), `dune-launch-emulator-${Date.now()}.sh`);
    const rom = path.join(os.tmpdir(), `dune-launch-rom-${Date.now()}.nes`);
    fs.writeFileSync(script, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(rom, 'rom');
    const game = { ...baseGame, source: 'emulator' as const, linPath: '', romPath: rom, emulator: script };

    expect(getLaunchCommand(game)?.command).toBe(script);
    expect(getLaunchCommand(game)?.args).toEqual([rom]);

    const exited = new Promise<{ startedAt: number; endedAt: number }>((resolve) => {
      void launchGame(game, {}, { onExit: resolve }).then((result) => {
        expect(result.success).toBe(true);
      });
    });
    const info = await exited;
    expect(info.endedAt).toBeGreaterThanOrEqual(info.startedAt);
  });

  it('reports a missing emulator command instead of claiming success', async () => {
    const rom = path.join(os.tmpdir(), `dune-launch-missing-rom-${Date.now()}.nes`);
    fs.writeFileSync(rom, 'rom');
    const game = {
      ...baseGame,
      source: 'emulator' as const,
      linPath: '',
      romPath: rom,
      emulator: `dune-missing-emulator-${Date.now()}`,
    };
    const result = await launchGame(game);
    expect(result.success).toBe(false);
    expect(result.message).toContain('Command not found');
  });
});
