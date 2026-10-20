import type { Game } from '@dune/shared';

export interface SearchResult {
  game: Game;
  score: number;
}

function normalize(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

export function searchLibrary(games: Game[], query: string): SearchResult[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return games.map((game) => ({ game, score: 0 }));

  return games
    .map((game) => {
      const haystack = [game.name, game.source, game.sourceId, ...(game.tags ?? [])].map(normalize).join(' ');
      let score = 0;
      for (const term of terms) {
        if (normalize(game.name) === term) score += 100;
        else if (normalize(game.name).startsWith(term)) score += 50;
        else if (haystack.includes(term)) score += 10;
      }
      return { game, score };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.game.name.localeCompare(b.game.name));
}
