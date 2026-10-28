/**
 * Store ids on Game (shared Game.steamAppId / Game.gogId): a positive integer
 * as a digit string (1-12 digits, no leading zero), or null. Mirrors the
 * server's STORE_ID_PATTERN (packages/server/src/schemas.ts:170), so an id
 * the client keeps is one the server accepts on upload (x-steam-app-id /
 * x-gog-id); anything else becomes null. Numbers are never stored or sent,
 * but a safe positive integer read from a launcher DB is converted.
 */
import type { Game } from '@dune/shared';

export const STORE_ID_PATTERN = /^[1-9][0-9]{0,11}$/;

export function normalizeStoreId(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? normalizeStoreId(String(value)) : null;
  }
  return typeof value === 'string' && STORE_ID_PATTERN.test(value) ? value : null;
}

export type StoreIds = Pick<Game, 'steamAppId' | 'gogId'>;

/** Only the ids that are set and valid; never `null`/`undefined` keys. */
export function validStoreIds(game: StoreIds): { steamAppId?: string; gogId?: string } {
  const steamAppId = normalizeStoreId(game.steamAppId);
  const gogId = normalizeStoreId(game.gogId);
  return { ...(steamAppId ? { steamAppId } : {}), ...(gogId ? { gogId } : {}) };
}

/**
 * Normalise ids already on a stored game: an invalid value becomes null, an
 * absent one stays absent (so untouched records stay byte-identical).
 */
export function normalizeGameStoreIds<T extends StoreIds>(game: T): T {
  let next = game;
  for (const key of ['steamAppId', 'gogId'] as const) {
    if (game[key] === undefined) continue;
    const v = normalizeStoreId(game[key]);
    if (v !== game[key]) next = { ...next, [key]: v };
  }
  return next;
}

/**
 * Fill missing ids on stored games from a scan, matched by exact name (the
 * same rule games:autodetect uses to decide a game is already stored). Never
 * overwrites a valid stored id; returns the games and how many changed.
 */
export function backfillStoreIds(stored: readonly Game[], scanned: readonly Game[]): { games: Game[]; changed: number } {
  const byName = new Map<string, Game>();
  for (const g of scanned) if (!byName.has(g.name)) byName.set(g.name, g);
  let changed = 0;
  const games = stored.map((game) => {
    const found = byName.get(game.name);
    if (!found) return game;
    const ids = validStoreIds(found);
    const patch: StoreIds = {};
    if (ids.steamAppId && !normalizeStoreId(game.steamAppId)) patch.steamAppId = ids.steamAppId;
    if (ids.gogId && !normalizeStoreId(game.gogId)) patch.gogId = ids.gogId;
    if (Object.keys(patch).length === 0) return game;
    changed++;
    return { ...game, ...patch };
  });
  return { games, changed };
}
