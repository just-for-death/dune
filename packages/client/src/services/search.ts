import type { Game } from '@dune/shared';

export interface SearchResult {
  game: Game;
  score: number;
}

interface IndexEntry {
  game: Game;
  /** Normalized name, e.g. "pokemon legends: arceus". */
  name: string;
  /** Normalized words of the name, for word-prefix matches. */
  nameWords: string[];
  /** Normalized name + source + sourceId + tags, space-joined. */
  haystack: string;
}

/** Prebuilt, normalized search index. Build once per games list (e.g. in useMemo). */
export interface SearchIndex {
  entries: IndexEntry[];
}

/**
 * Case- and diacritic-insensitive normalization: "Pokémon  ÉLAN" -> "pokemon elan".
 * NFKD splits accented letters into base + combining mark, which is then dropped.
 */
export function normalizeSearchText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildSearchIndex(games: readonly Game[]): SearchIndex {
  return {
    entries: games.map((game) => {
      const name = normalizeSearchText(game.name);
      return {
        game,
        name,
        nameWords: name.split(/[^\p{L}\p{N}]+/u).filter(Boolean),
        haystack: [name, game.source, game.sourceId, ...(game.tags ?? [])].map(normalizeSearchText).join(' '),
      };
    }),
  };
}

/**
 * Every term must match somewhere (AND). Scoring per term: exact name 100,
 * name prefix 50, word prefix 30, anywhere in name/source/tags 10.
 * An empty query returns every game in library order.
 */
export function searchIndex(index: SearchIndex, query: string): SearchResult[] {
  const terms = normalizeSearchText(query).split(' ').filter(Boolean);
  if (terms.length === 0) return index.entries.map(({ game }) => ({ game, score: 0 }));

  const results: SearchResult[] = [];
  for (const entry of index.entries) {
    let score = 0;
    let allMatched = true;
    for (const term of terms) {
      if (entry.name === term) score += 100;
      else if (entry.name.startsWith(term)) score += 50;
      else if (entry.nameWords.some((word) => word.startsWith(term))) score += 30;
      else if (entry.haystack.includes(term)) score += 10;
      else {
        allMatched = false;
        break;
      }
    }
    if (allMatched) results.push({ game: entry.game, score });
  }
  return results.sort((a, b) => b.score - a.score || a.game.name.localeCompare(b.game.name));
}

/** One-off search without keeping an index around. */
export function searchLibrary(games: readonly Game[], query: string): SearchResult[] {
  return searchIndex(buildSearchIndex(games), query);
}
