import { describe, it, expect } from 'vitest';
import type { Collection, Game } from '@dune/shared';
import { matchesCollection, filterCollection } from './collections';

const games: Game[] = [
  { id: 1, name: 'Hades', winPath: '', linPath: '/hades', lastSync: 'Never', status: 'In Sync', thumbnail: '', createdAt: '', updatedAt: '', source: 'steam', tags: ['roguelike'] },
  { id: 2, name: 'Hollow Knight', winPath: '', linPath: '/hk', lastSync: 'Never', status: 'Pending Upload', thumbnail: '', createdAt: '', updatedAt: '', source: 'gog', tags: ['metroidvania'] },
];

const collection: Collection = {
  id: 1,
  name: 'Steam synced',
  logic: 'all',
  rules: [
    { field: 'source', op: 'equals', value: 'steam' },
    { field: 'status', op: 'equals', value: 'In Sync' },
  ],
  createdAt: '',
  updatedAt: '',
};

describe('collections', () => {
  it('matches all rules by default', () => {
    expect(matchesCollection(games[0], collection)).toBe(true);
    expect(matchesCollection(games[1], collection)).toBe(false);
  });

  it('filters games', () => {
    expect(filterCollection(games, collection)).toHaveLength(1);
  });

  it('supports any logic', () => {
    const anyCollection: Collection = { ...collection, logic: 'any', rules: [{ field: 'source', op: 'equals', value: 'steam' }, { field: 'source', op: 'equals', value: 'gog' }] };
    expect(filterCollection(games, anyCollection)).toHaveLength(2);
  });
});
