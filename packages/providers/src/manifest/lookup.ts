import { normalizeTitle } from '../hltb/titles.js';
import type { ManifestGame } from './schema.js';

export interface ManifestQuery {
  /** Game title (case, width and whitespace insensitive). */
  title?: string;
  steamId?: number;
  gogId?: number;
}

export interface ManifestIndex {
  byTitle: Map<string, string>;
  bySteamId: Map<number, string>;
  byGogId: Map<number, string>;
}

/** First title wins on collisions (manifest order is alphabetical upstream). */
function put<K>(map: Map<K, string>, key: K | undefined, name: string): void {
  if (key !== undefined && !map.has(key)) map.set(key, name);
}

export function buildManifestIndex(games: Record<string, ManifestGame>): ManifestIndex {
  const index: ManifestIndex = { byTitle: new Map(), bySteamId: new Map(), byGogId: new Map() };
  for (const [name, game] of Object.entries(games)) {
    put(index.byTitle, normalizeTitle(name), name);
    if (game.alias) continue; // an alias only names another entry
    put(index.bySteamId, game.steam?.id, name);
    for (const id of game.id?.steamExtra ?? []) put(index.bySteamId, id, name);
    put(index.byGogId, game.gog?.id, name);
    for (const id of game.id?.gogExtra ?? []) put(index.byGogId, id, name);
  }
  return index;
}

/**
 * Resolve a query to a manifest entry. Store ids win over the title. An
 * alias is followed exactly one hop (an alias of an alias, or one pointing
 * at a missing title, resolves to nothing).
 */
export function findManifestGame(games: Record<string, ManifestGame>, index: ManifestIndex, query: ManifestQuery): { name: string; game: ManifestGame } | null {
  const name =
    (query.steamId !== undefined ? index.bySteamId.get(query.steamId) : undefined) ??
    (query.gogId !== undefined ? index.byGogId.get(query.gogId) : undefined) ??
    (typeof query.title === 'string' && query.title.trim() ? index.byTitle.get(normalizeTitle(query.title)) : undefined);
  if (name === undefined || !Object.hasOwn(games, name)) return null;
  const game = games[name]!;
  if (game.alias === undefined) return { name, game };
  const target = Object.hasOwn(games, game.alias) ? games[game.alias] : undefined;
  return target && target.alias === undefined ? { name: game.alias, game: target } : null;
}

/** PCGamingWiki article for a manifest title (Ludusavi titles are PCGW page names). */
export function pcgamingwikiPageUrl(title: string): string {
  return `https://www.pcgamingwiki.com/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}
