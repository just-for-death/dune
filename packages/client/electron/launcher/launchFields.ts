import type { Game } from '@dune/shared';

/**
 * DUN-061: launch fields are main-only.
 *
 * Main decides what a game runs (scanners, the store migration and the
 * main-side pickers/setters below). Game records that arrive from the
 * renderer or from a Dune Server only ever contribute display metadata; any
 * launch field they carry is dropped, never merged.
 */
export const LAUNCH_FIELDS = [
  'executable',
  'installPath',
  'emulator',
  'romPath',
  'winePrefix',
  'managedPrefixId',
  'protonPath',
  'steamAppId',
  'heroicId',
  'lutrisSlug',
  // Which strategy runs depends on these, so they are main-only too.
  'source',
  'sourceId',
] as const satisfies readonly (keyof Game)[];

/** Never stored at all; listed so callers can assert they are dropped. */
export const TRANSIENT_LAUNCH_KEYS = ['args', 'launchArgs', 'env', 'launchEnv', 'cwd', 'command', 'useUmu'] as const;

/** What the UI may edit: title, save paths, art and tags. */
export interface GameMetadata {
  name: string;
  winPath: string;
  linPath: string;
  thumbnail: string;
  tags?: string[];
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/**
 * Picks the renderer-editable metadata out of an untrusted record. Returns
 * null when the title is missing. Launch fields are never read.
 */
export function pickGameMetadata(input: unknown): GameMetadata | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const g = input as Record<string, unknown>;
  const name = str(g.name, 200).trim();
  if (!name) return null;
  const meta: GameMetadata = {
    name,
    winPath: str(g.winPath, 2000),
    linPath: str(g.linPath, 2000),
    thumbnail: str(g.thumbnail, 2000),
  };
  if (Array.isArray(g.tags)) {
    meta.tags = g.tags.filter((t): t is string => typeof t === 'string' && t.length > 0).map((t) => t.slice(0, 64)).slice(0, 64);
  }
  return meta;
}

/** A new game from `game:add`: metadata only, no launch target until main sets one. */
export function createGameFromMetadata(input: unknown, id: number, now: string): Game | null {
  const meta = pickGameMetadata(input);
  if (!meta) return null;
  return {
    ...meta,
    id,
    source: 'manual',
    lastSync: 'Never',
    status: 'Pending Upload',
    createdAt: now,
    updatedAt: now,
  };
}

function rawId(record: unknown): number | null {
  const id = (record as { id?: unknown } | null)?.id;
  return typeof id === 'number' && Number.isSafeInteger(id) ? id : null;
}

/**
 * Merge an untrusted game list (renderer `config:save`, or a server list)
 * into the stored games, by id.
 *
 * - An id the store already has keeps every stored field (launch fields,
 *   status, lastSync, createdAt, analysis); only metadata is taken from the
 *   incoming record. A record without a valid title leaves the game as stored.
 * - An id the store does not have is dropped (games are added only by
 *   `game:add` and the scanners).
 * - A stored game missing from the incoming list is kept: a merge never
 *   removes games (a stale renderer save must not drop games the scanner
 *   added meanwhile). Removal goes only through `game:remove(gameId)`.
 */
export function mergeIncomingGames(
  stored: readonly Game[],
  incoming: unknown,
  options: { now: string },
): Game[] {
  if (!Array.isArray(incoming)) return stored.map((g) => ({ ...g }));
  const updates = new Map<number, GameMetadata | null>();
  for (const record of incoming) {
    const id = rawId(record);
    if (id === null || updates.has(id)) continue;
    updates.set(id, pickGameMetadata(record));
  }
  const out: Game[] = [];
  for (const game of stored) {
    if (!updates.has(game.id)) {
      out.push({ ...game });
      continue;
    }
    const meta = updates.get(game.id);
    if (!meta) {
      out.push({ ...game });
      continue;
    }
    const changed = (Object.keys(meta) as (keyof GameMetadata)[])
      .some((key) => JSON.stringify(meta[key]) !== JSON.stringify(game[key]));
    out.push({ ...game, ...meta, ...(changed ? { updatedAt: options.now } : {}) });
  }
  return out;
}

/** Renderer `config:save`: merge metadata by id; never adds or removes games. */
export function mergeRendererGames(stored: readonly Game[], incoming: unknown, now: string): Game[] {
  return mergeIncomingGames(stored, incoming, { now });
}

/** Server game lists (sync pull / library import): merge by id; never remove, never add. */
export function mergeServerGames(stored: readonly Game[], incoming: unknown, now: string): Game[] {
  return mergeIncomingGames(stored, incoming, { now });
}
