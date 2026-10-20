import { describe, it, expect } from 'vitest';
import type { Game } from '@dune/shared';
import { searchLibrary } from './search';

const games: Game[] = [
  { id: 1, name: 'Hades', winPath: '', linPath: '', lastSync: 'Never', status: 'In Sync', thumbnail: '', createdAt: '', updatedAt: '', source: 'steam', tags: ['roguelike'] },
  { id: 2, name: 'Hollow Knight', winPath: '', linPath: '', lastSync: 'Never', status: 'In Sync', thumbnail: '', createdAt: '', updatedAt: '', source: 'gog', tags: ['metroidvania'] },
];

describe('searchLibrary', () => {
  it('returns all games for an empty query', () => {
    expect(searchLibrary(games, '')).toHaveLength(2);
  });

  it('ranks exact name matches first', () => {
    const results = searchLibrary(games, 'hades');
    expect(results[0].game.name).toBe('Hades');
  });

  it('searches tags and sources', () => {
    expect(searchLibrary(games, 'metroidvania')[0].game.name).toBe('Hollow Knight');
    expect(searchLibrary(games, 'gog')[0].game.name).toBe('Hollow Knight');
  });
});
