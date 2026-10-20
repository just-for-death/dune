import type { Collection, CollectionRule, Game } from '@dune/shared';

function normalize(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function ruleMatches(game: Game, rule: CollectionRule, playtimeMinutes = 0): boolean {
  const gameValue =
    rule.field === 'source' ? game.source ?? game.sourceId ?? ''
    : rule.field === 'status' ? game.status
    : rule.field === 'tag' ? (game.tags ?? []).join(' ')
    : rule.field === 'name' ? game.name
    : rule.field === 'playtime' ? playtimeMinutes
    : '';

  const expected = rule.value;
  const actualString = normalize(gameValue);
  const expectedString = normalize(expected);

  switch (rule.op) {
    case 'equals':
      return actualString === expectedString;
    case 'contains':
      return actualString.includes(expectedString);
    case 'startsWith':
      return actualString.startsWith(expectedString);
    case 'gt':
      return Number(gameValue) > Number(expected);
    case 'lt':
      return Number(gameValue) < Number(expected);
    default:
      return false;
  }
}

export function matchesCollection(game: Game, collection: Collection, playtimeMinutes = 0): boolean {
  if (collection.rules.length === 0) return true;
  const results = collection.rules.map((rule) => ruleMatches(game, rule, playtimeMinutes));
  return collection.logic === 'any' ? results.some(Boolean) : results.every(Boolean);
}

export function filterCollection(games: Game[], collection: Collection, playtimeByGame: Record<string, number> = {}): Game[] {
  return games.filter((game) => matchesCollection(game, collection, playtimeByGame[game.name] ?? 0));
}
