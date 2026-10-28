import { spawn, type ChildProcess } from 'child_process';
import type { Game } from '@dune/shared';
import { nativeStrategy } from './strategies/native.js';
import { steamStrategy } from './strategies/steam.js';
import { heroicStrategy } from './strategies/heroic.js';
import { lutrisStrategy } from './strategies/lutris.js';
import { wineStrategy } from './strategies/wine.js';
import { emulatorStrategy } from './strategies/emulator.js';
import { isUrlLaunch, type LaunchOptions, type LaunchPlan } from './strategies/types.js';
import { filterLaunchEnv } from '../launch/envAllowlist.js';

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

function safeOptionsOf(options: LaunchOptions): LaunchOptions {
  // DUN-061: per-game env only passes the allow-list; strategies then add the
  // main-owned WINEPREFIX / PROTONPATH on top.
  return options.env === undefined ? options : { ...options, env: filterLaunchEnv(options.env) };
}

export function getLaunchCommand(game: Game, options: LaunchOptions = {}): LaunchPlan | null {
  const safeOptions = safeOptionsOf(options);
  const strategy = selectLaunchStrategy(game, safeOptions);
  return strategy ? strategy.getCommand(game, safeOptions) : null;
}

/**
 * A user-facing reason why a game that a strategy would handle can't be
 * launched (DUN-075: no RetroArch core), or null.
 */
export function getLaunchRefusal(game: Game, options: LaunchOptions = {}): string | null {
  const safeOptions = safeOptionsOf(options);
  for (const strategy of strategies) {
    if (!strategy.canLaunch(game, safeOptions)) continue;
    const reason = strategy.refusal?.(game, safeOptions) ?? null;
    if (reason) return reason;
  }
  return null;
}

/** The subset of `child_process.spawn` the launcher uses; injectable for tests. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string; detached: boolean; stdio: 'ignore'; shell: false },
) => ChildProcess;

export interface LaunchTrackingHooks {
  /** Called once the spawned process exits (or errors). */
  onExit?: (info: { pid?: number; startedAt: number; endedAt: number }) => void;
  /** Test seam: replaces `child_process.spawn`. Always called with an args array and `shell: false`. */
  spawn?: SpawnFn;
  /** DUN-074: opens a launch URL (steam://...) via the OS; main passes `shell.openExternal`. */
  openExternal?: (url: string) => Promise<void>;
}

export async function launchGame(
  game: Game,
  options: LaunchOptions = {},
  hooks: LaunchTrackingHooks = {},
): Promise<{ success: boolean; message: string; pid?: number }> {
  const plan = getLaunchCommand(game, options);
  if (!plan) return { success: false, message: getLaunchRefusal(game, options) ?? 'No launch strategy available' };
  if (isUrlLaunch(plan)) {
    // Launcher URLs hand off to the launcher; its lifetime is not playtime.
    if (!hooks.openExternal) return { success: false, message: 'Cannot open launcher URLs here' };
    try {
      await hooks.openExternal(plan.url);
      return { success: true, message: 'Launched' };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : 'Launch failed' };
    }
  }
  const command = plan;

  const startedAt = Date.now();
  let child: ChildProcess;
  try {
    const spawnFn: SpawnFn = hooks.spawn ?? (spawn as unknown as SpawnFn);
    // DUN-061: argv array, never a shell string.
    child = spawnFn(command.command, [...command.args], {
      env: { ...process.env, ...(command.env || {}) },
      cwd: command.cwd,
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
  } catch (error) {
    return { success: false, message: launchErrorMessage(error, command.command) };
  }

  const pid = child.pid;
  // Protocol/launcher helpers (Steam, Heroic, Lutris) exit immediately or
  // outlive the game. Only direct game processes (native, Wine, emulators)
  // map their process lifetime to playtime.
  const directLaunch = game.source === 'emulator'
    || command.command === game.executable
    || command.command === game.installPath
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
