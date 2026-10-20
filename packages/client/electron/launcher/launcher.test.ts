import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Game } from '@dune/shared';
import { getLaunchCommand, selectLaunchStrategy } from './manager.js';

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
});
