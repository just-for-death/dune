import type { Game, LaunchCommandResult, LaunchResult } from '@dune/shared';
import { getLaunchCommand, launchGame, type SpawnFn } from './manager.js';
import type { LaunchOptions } from './strategies/types.js';

/**
 * DUN-061: launch by game id only.
 *
 * The renderer sends a game id and nothing else. Main looks the game up in
 * its own store (scanned + manual games) and builds the executable, args,
 * cwd, launcher and Wine/Proton prefix from that record. Any other IPC
 * argument (a Game object, paths, args, env such as LD_PRELOAD) is ignored.
 */
export interface LaunchByIdDeps {
  /** Main's game store (scanned and manual games). */
  getGames: () => readonly Game[] | Promise<readonly Game[]>;
  /** Optional per-game env stored in main; always filtered by the env allow-list. */
  getGameEnv?: (game: Game) => unknown;
  /** Called when a direct-launch process exits (playtime, achievement import). */
  onExit?: (game: Game, info: { pid?: number; startedAt: number; endedAt: number }) => void;
  /** Test seam: replaces `child_process.spawn`. */
  spawn?: SpawnFn;
  /**
   * Resolves a DUN-062 managed prefix id (`game.managedPrefixId`) to its path,
   * or null when the prefix is gone / not managed. Resolved at launch time.
   */
  resolveManagedPrefix?: (prefixId: string) => string | null;
}

/** A game id is a positive safe integer (see `nextId`). Strings, objects, NaN are rejected. */
export function parseGameId(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : null;
}

async function findStoredGame(rawId: unknown, deps: LaunchByIdDeps): Promise<Game | null> {
  const id = parseGameId(rawId);
  if (id === null) return null;
  const games = await deps.getGames();
  return (Array.isArray(games) ? games : []).find((g) => g?.id === id) ?? null;
}

/**
 * Launch options derived from the stored record only (the strategies read the
 * rest from `game`). Null when the game's managed prefix cannot be resolved.
 */
function storedLaunchOptions(game: Game, deps: LaunchByIdDeps): LaunchOptions | null {
  const options: LaunchOptions = {};
  const env = deps.getGameEnv?.(game);
  // getLaunchCommand filters env through the allow-list.
  if (env !== undefined) options.env = env as Record<string, string>;
  if (game.managedPrefixId) {
    const prefixPath = deps.resolveManagedPrefix?.(game.managedPrefixId) ?? null;
    if (!prefixPath) return null;
    options.winePrefix = prefixPath;
  }
  return options;
}

export async function launchGameById(rawId: unknown, deps: LaunchByIdDeps): Promise<LaunchResult> {
  let game: Game | null;
  try {
    game = await findStoredGame(rawId, deps);
  } catch (error) {
    return { ok: false, reason: 'error', message: error instanceof Error ? error.message : 'Launch failed' };
  }
  if (!game) return { ok: false, reason: 'not-found' };

  const stored = game;
  try {
    const options = storedLaunchOptions(stored, deps);
    if (!options || !getLaunchCommand(stored, options)) return { ok: false, reason: 'not-launchable' };
    const result = await launchGame(stored, options, {
      spawn: deps.spawn,
      onExit: deps.onExit ? (info) => deps.onExit?.(stored, info) : undefined,
    });
    return result.success
      ? { ok: true, ...(result.pid !== undefined ? { pid: result.pid } : {}) }
      : { ok: false, reason: 'error', message: result.message };
  } catch (error) {
    return { ok: false, reason: 'error', message: error instanceof Error ? error.message : 'Launch failed' };
  }
}

/** Preview of the command main would run for a stored game (nothing is spawned). */
export async function getLaunchCommandById(rawId: unknown, deps: LaunchByIdDeps): Promise<LaunchCommandResult> {
  try {
    const game = await findStoredGame(rawId, deps);
    if (!game) return { ok: false, reason: 'not-found' };
    const options = storedLaunchOptions(game, deps);
    const command = options ? getLaunchCommand(game, options) : null;
    return command ? { ok: true, command } : { ok: false, reason: 'not-launchable' };
  } catch (error) {
    return { ok: false, reason: 'error', message: error instanceof Error ? error.message : 'Launch failed' };
  }
}

/**
 * IPC handlers for `game:launch` / `game:launchCommand`. Each takes exactly
 * one argument after the event, the game id; extra IPC arguments are dropped.
 */
export function createLaunchIpcHandlers(deps: LaunchByIdDeps) {
  return {
    launch: (_event: unknown, gameId: unknown): Promise<LaunchResult> => launchGameById(gameId, deps),
    launchCommand: (_event: unknown, gameId: unknown): Promise<LaunchCommandResult> => getLaunchCommandById(gameId, deps),
  };
}
