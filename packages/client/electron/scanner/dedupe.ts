/**
 * Deterministic cross-source dedupe for scanner results.
 *
 * Two scanner games are the same game when they share (in this order):
 *   1. a Steam app id,
 *   2. a normalized install path,
 *   3. a normalized name within the same source family
 *      (e.g. Heroic's GOG entry and the GOG folder scanner are both "gog").
 * The most specific source wins (Steam > Heroic > Lutris > external folder
 * scanners > manifest-only matches) and empty fields are filled from the other
 * entries, so launcher metadata is merged rather than dropped. Manual and
 * emulator entries are never merged.
 */
import * as path from 'path';
import type { Game } from '@dune/shared';
import { normalizeGameName } from './savePaths.js';

const SOURCE_RANK: Record<string, number> = {
  steam: 0,
  heroic: 1,
  lutris: 2,
  epic: 3,
  gog: 3,
  ubisoft: 3,
  ea: 3,
  battlenet: 3,
  xbox: 3,
  minecraft: 3,
};
const MANIFEST_RANK = 4;

function sourceOf(game: Game): string {
  return game.source || game.sourceId || '';
}

function rankOf(game: Game): number {
  return SOURCE_RANK[sourceOf(game)] ?? MANIFEST_RANK;
}

function isDedupable(game: Game): boolean {
  const src = sourceOf(game);
  return src !== 'manual' && src !== 'emulator';
}

/** Store family used for name matching (Heroic entries belong to their store). */
export function sourceFamily(game: Game): string {
  const src = sourceOf(game);
  if (src === 'heroic') {
    const platform = (game as Game & { platform?: string }).platform;
    return platform || 'heroic';
  }
  return src || 'manifest';
}

export function normalizeInstallPath(p: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = path.resolve(p).replace(/[\\/]+$/, '');
  return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

function keysFor(game: Game): string[] {
  const keys: string[] = [];
  if (game.steamAppId) keys.push(`steam:${game.steamAppId}`);
  if (game.installPath) keys.push(`install:${normalizeInstallPath(game.installPath)}`);
  const name = normalizeGameName(game.name || '');
  if (name) {
    keys.push(`name:${sourceFamily(game)}:${name}`);
  }
  return keys;
}

const MERGE_FIELDS: Array<keyof Game> = [
  'winPath', 'linPath', 'installPath', 'steamAppId', 'heroicId', 'lutrisSlug',
  'winePrefix', 'protonPath', 'executable', 'thumbnail',
];

function mergeInto(primary: Game, other: Game): Game {
  const merged: Game = { ...primary };
  const target = merged as unknown as Record<string, unknown>;
  const source = other as unknown as Record<string, unknown>;
  for (const field of MERGE_FIELDS) {
    if (!target[field] && source[field]) target[field] = source[field];
  }
  if (other.tags?.length) merged.tags = Array.from(new Set([...(primary.tags ?? []), ...other.tags]));
  return merged;
}

export function dedupeGames(games: Game[]): Game[] {
  const indexed = games.map((game, index) => ({ game, index }));
  // Most specific first; ties keep scan order.
  const ordered = indexed
    .filter(({ game }) => isDedupable(game))
    .sort((a, b) => rankOf(a.game) - rankOf(b.game) || a.index - b.index);

  interface Group { game: Game; firstIndex: number; keys: Set<string> }
  const groups: Group[] = [];
  const byKey = new Map<string, Group>();

  for (const { game, index } of ordered) {
    const keys = keysFor(game);
    const matches: Group[] = [];
    for (const key of keys) {
      const g = byKey.get(key);
      if (g && !matches.includes(g)) matches.push(g);
    }
    // Manifest-only names may also fold into a store entry with the same name.
    const name = normalizeGameName(game.name || '');
    if (rankOf(game) === MANIFEST_RANK && name) {
      for (const g of groups) {
        if (!matches.includes(g) && normalizeGameName(g.game.name || '') === name) matches.push(g);
      }
    }

    if (matches.length === 0) {
      const group: Group = { game, firstIndex: index, keys: new Set(keys) };
      groups.push(group);
      for (const key of keys) byKey.set(key, group);
      continue;
    }

    // Merge into the earliest-created (most specific) group, folding any others in.
    matches.sort((a, b) => groups.indexOf(a) - groups.indexOf(b));
    const [target, ...rest] = matches;
    for (const other of rest) {
      target.game = mergeInto(target.game, other.game);
      target.firstIndex = Math.min(target.firstIndex, other.firstIndex);
      for (const key of other.keys) { target.keys.add(key); byKey.set(key, target); }
      groups.splice(groups.indexOf(other), 1);
    }
    target.game = mergeInto(target.game, game);
    target.firstIndex = Math.min(target.firstIndex, index);
    for (const key of keysFor(target.game).concat(keys)) { target.keys.add(key); byKey.set(key, target); }
  }

  const kept = [
    ...groups.map(g => ({ game: g.game, index: g.firstIndex })),
    ...indexed.filter(({ game }) => !isDedupable(game)),
  ];
  return kept.sort((a, b) => a.index - b.index).map(({ game }) => game);
}
