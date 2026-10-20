import { spawn, type ChildProcess } from 'child_process';
import type { Game } from '@dune/shared';
import { nativeStrategy } from './strategies/native.js';
import { steamStrategy } from './strategies/steam.js';
import { heroicStrategy } from './strategies/heroic.js';
import { lutrisStrategy } from './strategies/lutris.js';
import { wineStrategy } from './strategies/wine.js';
import { emulatorStrategy } from './strategies/emulator.js';
import type { LaunchCommand, LaunchOptions } from './strategies/types.js';

const strategies = [
  steamStrategy,
  heroicStrategy,
  lutrisStrategy,
  wineStrategy,
  emulatorStrategy,
  nativeStrategy,
];

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

  const startedAt = Date.now();
  let child: ChildProcess;
  try {
    child = spawn(command.command, command.args, {
      env: { ...process.env, ...(command.env || {}) },
      cwd: command.cwd,
      detached: true,
      stdio: 'ignore',
    });
  } catch (error) {
    return { success: false, message: launchErrorMessage(error, command.command) };
  }

  const pid = child.pid;
  // Protocol/launcher helpers (Steam, Heroic, Lutris) exit immediately or
  // outlive the game. Only direct game processes (native, Wine, emulators)
  // map their process lifetime to playtime.
  const directLaunch = game.source === 'emulator'
    || command.command === (game.executable || game.linPath)
    || command.command === 'wine'
    || command.command === 'umu-run';

  return new Promise((resolve) => {
    let settled = false;
    let spawned = false;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      hooks.onExit?.({ pid, startedAt, endedAt: Date.now() });
    };

    child.once('spawn', () => {
      spawned = true;
      if (settled) return;
      settled = true;
      resolve({ success: true, message: 'Launched', pid });
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      resolve({ success: false, message: launchErrorMessage(error, command.command), pid });
    });
    if (directLaunch) {
      child.once('exit', () => {
        if (spawned) finish();
      });
    }
    child.unref();
  });
}

function launchErrorMessage(error: unknown, command: string): string {
  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
    return `Command not found: ${command}`;
  }
  return error instanceof Error ? error.message : 'Launch failed';
}
