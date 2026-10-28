/**
 * game:setSavePath (PL ruling 2026-10-28). Sets ONLY the game's save path for this platform
 * (linPath on Linux/macOS, winPath on Windows; the field savePathOf reads). The path must pass
 * the manifest-suggestion rules (./expand.ts confinePath): absolute and already expanded (no
 * placeholders, globs or `~`), no `..`, strictly inside the home dir, the game's installPath or
 * its prefix, also after realpath (no symlink escapes). The stored value is that resolved path.
 * Nothing on disk is read (beyond lstat/realpath), created, moved or written.
 */
import type { ElectronAPI, Game, ServerFailure } from '@dune/shared';
import type { MaybePromise } from '../providers/types';
import { confinePath, rootsOf, MAX_PATH_LENGTH, type ExpandContext } from './expand';

export type SetSavePathResult = Awaited<ReturnType<ElectronAPI['setSavePath']>>;

export interface SetSavePathDeps {
  getGames(): MaybePromise<Game[]>;
  setGames(games: Game[]): void;
  expandContext(game: Game): MaybePromise<ExpandContext>;
  platform?: NodeJS.Platform;
  now?: () => string;
}

const fail = (code: string, message: string): ServerFailure => ({ ok: false, code, message });

/** Shape checks before any filesystem call. */
export function checkSavePathInput(raw: unknown): string | ServerFailure {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > MAX_PATH_LENGTH) return fail('INVALID_SAVE_PATH', 'Enter a save folder path.');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return fail('INVALID_SAVE_PATH', 'The path contains control characters.');
  if (/<[A-Za-z]+>/.test(raw) || raw.startsWith('~') || raw.includes('$')) return fail('INVALID_SAVE_PATH', 'Use the full, expanded path.');
  if (/[*?[\]{}\\]/.test(raw)) return fail('INVALID_SAVE_PATH', 'Wildcards are not allowed in a save path.');
  if (!raw.startsWith('/')) return fail('INVALID_SAVE_PATH', 'Use an absolute path.');
  return raw;
}

export async function setGameSavePath(deps: SetSavePathDeps, rawId: unknown, rawPath: unknown): Promise<SetSavePathResult> {
  try {
    // Same id shape as setGamePrefix: a positive integer number.
    const id = typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId > 0 ? rawId : null;
    if (id === null) return fail('INVALID_GAME_ID', 'Invalid game id');
    const input = checkSavePathInput(rawPath);
    if (typeof input !== 'string') return input;
    const games = await deps.getGames();
    const index = games.findIndex((g) => g.id === id);
    if (index < 0) return fail('GAME_NOT_FOUND', 'Game not found');
    const c = confinePath(input, rootsOf(await deps.expandContext(games[index])));
    if (!c.ok) {
      if (c.reason === 'dot-dot') return fail('SAVE_PATH_ESCAPE', 'The path may not contain "..".');
      if (c.reason === 'symlink-escape') return fail('SAVE_PATH_ESCAPE', 'The path leads outside your home folder, the game folder and its prefix.');
      if (c.reason === 'outside-roots') return fail('SAVE_PATH_OUTSIDE_ROOTS', 'Choose a folder inside your home folder, the game folder or its prefix.');
      return fail('INVALID_SAVE_PATH', 'Use an absolute path.');
    }
    const field = (deps.platform ?? process.platform) === 'win32' ? 'winPath' : 'linPath';
    const game: Game = { ...games[index], [field]: c.path, updatedAt: deps.now?.() ?? new Date().toISOString() };
    const next = games.slice();
    next[index] = game;
    deps.setGames(next);
    return { ok: true, game };
  } catch {
    return fail('SAVE_PATH_ERROR', 'Could not update the save path.');
  }
}
