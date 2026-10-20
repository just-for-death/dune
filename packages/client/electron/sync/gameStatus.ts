import type { Game } from '@dune/shared';

// Follow-up (c): sync and restore await the network for a long time. They
// must not write back the game list they read at the start (that would drop
// games added, removed or edited meanwhile). Instead they re-read the store
// afterwards and patch only `status` / `lastSync` on the game ids they touched.

export interface GameStatusPatch {
  status: Game['status'];
  lastSync?: string;
}

/** Returns a new list: only matching ids get `status` (and `lastSync` when given). */
export function applyGameStatusPatches(current: readonly Game[], patches: ReadonlyMap<number, GameStatusPatch>): Game[] {
  return current.map((g) => {
    const patch = patches.get(g.id);
    if (!patch) return g;
    return { ...g, status: patch.status, ...(patch.lastSync !== undefined ? { lastSync: patch.lastSync } : {}) };
  });
}

/** Re-read the store, patch, write back. Nothing is written when no patch applies. */
export function commitGameStatusPatches(
  store: { get(key: 'games'): unknown; set(key: 'games', value: Game[]): void },
  patches: ReadonlyMap<number, GameStatusPatch>,
): void {
  if (patches.size === 0) return;
  const fresh = (store.get('games') || []) as Game[];
  if (!fresh.some((g) => patches.has(g.id))) return;
  store.set('games', applyGameStatusPatches(fresh, patches));
}
