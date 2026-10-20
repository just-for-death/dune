import * as fs from 'fs';
import * as path from 'path';
import type {
  AddGameResult,
  EmulatorInfo,
  Game,
  ManagedPrefix,
  PickLaunchTargetResult,
  RemoveGameResult,
  SetGameEmulatorResult,
  SetGamePrefixResult,
} from '@dune/shared';
import { parseGameId } from './byId.js';
import { createGameFromMetadata, mergeRendererGames } from './launchFields.js';
import { isKnownEmulator, listKnownEmulators } from './emulators.js';

/**
 * DUN-061: the only ways a game's launch fields change after a scan.
 * Every setter takes a game id plus a main-validated choice (a file the user
 * picked in main's own dialog, a managed prefix id, a known emulator id);
 * the renderer never sends a path or command.
 */
export interface GameSettingsDeps {
  getGames: () => readonly Game[] | Promise<readonly Game[]>;
  setGames: (games: Game[]) => void;
  /** Main's file dialog (Electron `dialog.showOpenDialog`); injectable for tests. */
  showOpenDialog: (options: { title: string; properties: ['openFile'] }) => Promise<{ canceled: boolean; filePaths: string[] }>;
  /** DUN-062 managed prefixes. */
  listPrefixes: () => readonly ManagedPrefix[];
  nextId: () => number;
  now?: () => string;
  statSync?: (p: string) => Pick<fs.Stats, 'isFile'>;
  log?: (message: string) => void;
}

type WithGame = { game: Game; games: Game[]; index: number };

async function loadGame(deps: GameSettingsDeps, rawId: unknown): Promise<WithGame | null> {
  const id = parseGameId(rawId);
  if (id === null) return null;
  const games = [...await deps.getGames()].map((g) => ({ ...g }));
  const index = games.findIndex((g) => g.id === id);
  return index === -1 ? null : { game: games[index], games, index };
}

function nowOf(deps: GameSettingsDeps): string {
  return deps.now ? deps.now() : new Date().toISOString();
}

function logError(deps: GameSettingsDeps, what: string, error: unknown) {
  (deps.log ?? ((m: string) => console.error(m)))(`[launch] ${what}: ${error instanceof Error ? error.message : String(error)}`);
}

/** `game:add`: metadata only. Launch fields in the payload are ignored. */
export async function addGame(deps: GameSettingsDeps, input: unknown): Promise<AddGameResult> {
  try {
    const game = createGameFromMetadata(input, deps.nextId(), nowOf(deps));
    if (!game) return { ok: false, reason: 'invalid' };
    const games = [...await deps.getGames(), game];
    deps.setGames(games);
    return { ok: true, game, games };
  } catch (error) {
    logError(deps, 'add', error);
    return { ok: false, reason: 'error' };
  }
}

/** `config:save` games: merge by id (see launchFields.ts). Returns the stored list. */
export async function saveRendererGames(deps: GameSettingsDeps, incoming: unknown): Promise<Game[]> {
  const merged = mergeRendererGames(await deps.getGames(), incoming, nowOf(deps));
  deps.setGames(merged);
  return merged;
}

/**
 * `game:remove(gameId)`: the only way a game leaves the store. Reads the
 * current list (never a renderer copy) and removes just that id. Local save
 * files and the server copy are left untouched.
 */
export async function removeGame(deps: GameSettingsDeps, rawId: unknown): Promise<RemoveGameResult> {
  try {
    const id = parseGameId(rawId);
    if (id === null) return { ok: false, reason: 'invalid' };
    const current = await deps.getGames();
    if (!current.some((g) => g.id === id)) return { ok: false, reason: 'not-found' };
    const games = current.filter((g) => g.id !== id).map((g) => ({ ...g }));
    deps.setGames(games);
    return { ok: true, games };
  } catch (error) {
    logError(deps, 'remove', error);
    return { ok: false, reason: 'error' };
  }
}

/**
 * `game:pickLaunchTarget`: main opens its own file dialog. The chosen path must
 * be an existing regular file; it is stored as `romPath` for emulator games
 * and as `executable` otherwise. Cancel leaves the game untouched.
 */
export async function pickLaunchTarget(deps: GameSettingsDeps, rawId: unknown): Promise<PickLaunchTargetResult> {
  try {
    const before = await loadGame(deps, rawId);
    if (!before) return { ok: false, reason: 'not-found' };
    const isEmulator = before.game.source === 'emulator';
    const picked = await deps.showOpenDialog({
      title: isEmulator ? `Select ROM for ${before.game.name}` : `Select executable for ${before.game.name}`,
      properties: ['openFile'],
    });
    if (!picked || picked.canceled || !Array.isArray(picked.filePaths) || picked.filePaths.length === 0) {
      return { ok: false, reason: 'cancelled' };
    }
    const file = picked.filePaths[0];
    if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) return { ok: false, reason: 'invalid' };
    try {
      if (!(deps.statSync ?? fs.statSync)(file).isFile()) return { ok: false, reason: 'invalid' };
    } catch {
      return { ok: false, reason: 'invalid' };
    }
    // Re-read: the store may have changed while the dialog was open.
    const current = await loadGame(deps, rawId);
    if (!current) return { ok: false, reason: 'not-found' };
    const field = current.game.source === 'emulator' ? 'romPath' : 'executable';
    const game: Game = { ...current.game, [field]: file, updatedAt: nowOf(deps) };
    current.games[current.index] = game;
    deps.setGames(current.games);
    return { ok: true, game };
  } catch (error) {
    logError(deps, 'pickLaunchTarget', error);
    return { ok: false, reason: 'error' };
  }
}

/** `game:setPrefix`: a DUN-062 managed prefix id, or null to clear. Resolved to a path at launch. */
export async function setGamePrefix(deps: GameSettingsDeps, rawId: unknown, prefixId: unknown): Promise<SetGamePrefixResult> {
  try {
    if (prefixId !== null && typeof prefixId !== 'string') return { ok: false, reason: 'prefix-not-found' };
    const current = await loadGame(deps, rawId);
    if (!current) return { ok: false, reason: 'not-found' };
    if (prefixId !== null && !deps.listPrefixes().some((p) => p.id === prefixId)) {
      return { ok: false, reason: 'prefix-not-found' };
    }
    const game: Game = { ...current.game, updatedAt: nowOf(deps) };
    if (prefixId === null) delete game.managedPrefixId;
    else game.managedPrefixId = prefixId;
    current.games[current.index] = game;
    deps.setGames(current.games);
    return { ok: true, game };
  } catch (error) {
    logError(deps, 'setGamePrefix', error);
    return { ok: false, reason: 'error' };
  }
}

export function listEmulators(): EmulatorInfo[] {
  return listKnownEmulators();
}

/** `game:setEmulator`: a known emulator id, or null for the default (RetroArch). */
export async function setGameEmulator(deps: GameSettingsDeps, rawId: unknown, emulatorId: unknown): Promise<SetGameEmulatorResult> {
  try {
    if (emulatorId !== null && !isKnownEmulator(emulatorId)) return { ok: false, reason: 'unknown-emulator' };
    const current = await loadGame(deps, rawId);
    if (!current) return { ok: false, reason: 'not-found' };
    if (current.game.source !== 'emulator') return { ok: false, reason: 'not-emulator' };
    const game: Game = { ...current.game, updatedAt: nowOf(deps) };
    if (emulatorId === null) delete game.emulator;
    else game.emulator = emulatorId;
    current.games[current.index] = game;
    deps.setGames(current.games);
    return { ok: true, game };
  } catch (error) {
    logError(deps, 'setGameEmulator', error);
    return { ok: false, reason: 'error' };
  }
}

/** IPC handlers; each takes only the documented arguments after the event. */
export function createGameSettingsIpcHandlers(deps: GameSettingsDeps) {
  return {
    add: (_event: unknown, metadata: unknown) => addGame(deps, metadata),
    remove: (_event: unknown, gameId: unknown) => removeGame(deps, gameId),
    pickLaunchTarget: (_event: unknown, gameId: unknown) => pickLaunchTarget(deps, gameId),
    setPrefix: (_event: unknown, gameId: unknown, prefixId: unknown) => setGamePrefix(deps, gameId, prefixId),
    listEmulators: () => listEmulators(),
    setEmulator: (_event: unknown, gameId: unknown, emulatorId: unknown) => setGameEmulator(deps, gameId, emulatorId),
  };
}
