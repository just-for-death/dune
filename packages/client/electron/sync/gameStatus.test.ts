import { describe, it, expect } from 'vitest';
import type { Game } from '@dune/shared';
import { applyGameStatusPatches, commitGameStatusPatches, type GameStatusPatch } from './gameStatus';

const g = (id: number, name: string): Game => ({ id, name, winPath: '', linPath: '', lastSync: 'Never', status: 'Pending Upload', thumbnail: '', createdAt: 'c', updatedAt: 'u' });

describe('follow-up (c): status patches on a fresh store read', () => {
  it('a game added and a game removed during the await survive the sync write', () => {
    const snapshot = [g(1, 'A'), g(2, 'B')];
    let stored: Game[] = [...snapshot];
    const store = { get: () => stored, set: (_k: 'games', v: Game[]) => { stored = v; } };
    // While the network call is pending: the scanner adds 3, the user removes 2 and renames 1.
    stored = [{ ...g(1, 'A renamed') }, g(3, 'Scanned')];
    const patches = new Map<number, GameStatusPatch>([[1, { status: 'In Sync', lastSync: '2026-10-20T07:45:00.000Z' }], [2, { status: 'Error' }]]);
    commitGameStatusPatches(store, patches);
    expect(stored.map((x) => x.id)).toEqual([1, 3]);
    expect(stored[0]).toMatchObject({ name: 'A renamed', status: 'In Sync', lastSync: '2026-10-20T07:45:00.000Z' });
    expect(stored[1]).toEqual(g(3, 'Scanned'));
  });

  it('only status/lastSync change, lastSync is kept when not given, and nothing is written without a match', () => {
    const list = [g(1, 'A')];
    expect(applyGameStatusPatches(list, new Map([[1, { status: 'Error' as const }]]))[0]).toEqual({ ...list[0], status: 'Error' });
    let writes = 0;
    commitGameStatusPatches({ get: () => list, set: () => { writes++; } }, new Map([[9, { status: 'Error' as const }]]));
    commitGameStatusPatches({ get: () => list, set: () => { writes++; } }, new Map());
    expect(writes).toBe(0);
  });
});
