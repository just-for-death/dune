import { describe, it, expect } from 'vitest';
import type { Game } from '@dune/shared';
import { buildSearchIndex, normalizeSearchText, searchIndex, searchLibrary } from './search';

const base = { winPath: '', linPath: '', lastSync: 'Never', status: 'In Sync' as const, thumbnail: '', createdAt: '', updatedAt: '' };

const games: Game[] = [
  { ...base, id: 1, name: 'Hades', source: 'steam', tags: ['roguelike'] },
  { ...base, id: 2, name: 'Hollow Knight', source: 'gog', tags: ['metroidvania'] },
  { ...base, id: 3, name: 'Pokémon Legends: Arceus', source: 'emulator', tags: ['Créature'] },
  { ...base, id: 4, name: 'Hades II', source: 'steam' },
];

describe('normalizeSearchText', () => {
  it('folds case, diacritics and whitespace', () => {
    expect(normalizeSearchText('  Pokémon   ÉLAN ')).toBe('pokemon elan');
    expect(normalizeSearchText('Ōkami Ñandú Ærø')).toBe('okami nandu ærø');
    expect(normalizeSearchText(undefined)).toBe('');
  });
});

describe('searchLibrary', () => {
  it('returns all games for an empty query', () => {
    expect(searchLibrary(games, '')).toHaveLength(games.length);
    expect(searchLibrary(games, '   ').map((r) => r.game.id)).toEqual([1, 2, 3, 4]);
  });

  it('ranks exact name matches first', () => {
    const results = searchLibrary(games, 'hades');
    expect(results.map((r) => r.game.name)).toEqual(['Hades', 'Hades II']);
  });

  it('searches tags and sources', () => {
    expect(searchLibrary(games, 'metroidvania')[0].game.name).toBe('Hollow Knight');
    expect(searchLibrary(games, 'gog')[0].game.name).toBe('Hollow Knight');
  });

  it('is case- and diacritic-insensitive in both directions', () => {
    expect(searchLibrary(games, 'POKEMON').map((r) => r.game.id)).toEqual([3]);
    expect(searchLibrary(games, 'pokémon').map((r) => r.game.id)).toEqual([3]);
    expect(searchLibrary(games, 'creature').map((r) => r.game.id)).toEqual([3]);
    expect(searchLibrary(games, 'HÁDES')[0].game.id).toBe(1);
  });

  it('requires every term to match and prefers word prefixes', () => {
    expect(searchLibrary(games, 'hollow steam')).toEqual([]);
    expect(searchLibrary(games, 'legends arc').map((r) => r.game.id)).toEqual([3]);
    const knight = searchLibrary(games, 'kni');
    expect(knight.map((r) => r.game.id)).toEqual([2]);
    expect(knight[0].score).toBe(30);
  });

  it('returns nothing when no game matches', () => {
    expect(searchLibrary(games, 'zelda')).toEqual([]);
  });
});

describe('buildSearchIndex / searchIndex', () => {
  it('reuses one index for many queries without mutating it', () => {
    const index = buildSearchIndex(games);
    expect(index.entries).toHaveLength(4);
    expect(searchIndex(index, 'hades')).toHaveLength(2);
    expect(searchIndex(index, 'knight')).toHaveLength(1);
    expect(searchIndex(index, '')).toHaveLength(4);
    expect(index.entries.map((e) => e.game)).toEqual(games);
  });

  it('keeps references to the original game objects', () => {
    const index = buildSearchIndex(games);
    expect(searchIndex(index, 'arceus')[0].game).toBe(games[2]);
  });
});
