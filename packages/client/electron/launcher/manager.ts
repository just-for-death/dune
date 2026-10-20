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

export interface LaunchTrackingHooks {
  /** Called once the spawned process exits (or errors). */
  onExit?: (info: { pid?: number; startedAt: number; endedAt: number }) => void;
}

export async function launchGame(
  game: Game,
  options: LaunchOptions = {},
  hooks: LaunchTrackingHooks = {},
): Promise<{ success: boolean; message: string; pid?: number }> {
  const command = getLaunchCommand(game, options);
  if (!command) return { success: false, message: 'No launch strategy available' };

  return new Promise((resolve) => {
    const startedAt = Date.now();
    try {
      const child = spawn(command.command, command.args, {
        env: { ...process.env, ...(command.env || {}) },
        cwd: command.cwd,
        detached: true,
        stdio: 'ignore',
      });
      const pid = child.pid;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        hooks.onExit?.({ pid, startedAt, endedAt: Date.now() });
      };
      // Protocol/launcher helpers (Steam, Heroic, Lutris) exit immediately or
      // outlive the game. Only direct native/Wine processes map to playtime.
      const directLaunch = command.command === (game.executable || game.linPath)
        || command.command === 'wine'
        || command.command === 'umu-run';
      if (directLaunch) {
        child.once('exit', finish);
        child.once('error', finish);
      }
      child.unref();
      resolve({ success: true, message: 'Launched', pid });
    } catch (error) {
      resolve({ success: false, message: error instanceof Error ? error.message : 'Launch failed' });
    }
  });
}
