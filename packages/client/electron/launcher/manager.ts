import { spawn } from 'child_process';
import type { Game } from '@dune/shared';
import { nativeStrategy } from './strategies/native.js';
import { steamStrategy } from './strategies/steam.js';
import { heroicStrategy } from './strategies/heroic.js';
import { lutrisStrategy } from './strategies/lutris.js';
import { wineStrategy } from './strategies/wine.js';
import type { LaunchCommand, LaunchOptions } from './strategies/types.js';

const strategies = [steamStrategy, heroicStrategy, lutrisStrategy, wineStrategy, nativeStrategy];

export function selectLaunchStrategy(game: Game, options: LaunchOptions = {}) {
  return strategies.find((strategy) => strategy.canLaunch(game, options) && strategy.getCommand(game, options) !== null) ?? null;
}

export function getLaunchCommand(game: Game, options: LaunchOptions = {}): LaunchCommand | null {
  const strategy = selectLaunchStrategy(game, options);
  return strategy ? strategy.getCommand(game, options) : null;
}

export async function launchGame(game: Game, options: LaunchOptions = {}): Promise<{ success: boolean; message: string; pid?: number }> {
  const command = getLaunchCommand(game, options);
  if (!command) return { success: false, message: 'No launch strategy available' };

  return new Promise((resolve) => {
    try {
      const child = spawn(command.command, command.args, {
        env: { ...process.env, ...(command.env || {}) },
        cwd: command.cwd,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      resolve({ success: true, message: 'Launched', pid: child.pid });
    } catch (error) {
      resolve({ success: false, message: error instanceof Error ? error.message : 'Launch failed' });
    }
  });
}
