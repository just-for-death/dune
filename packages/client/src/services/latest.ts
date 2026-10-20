/**
 * "Latest wins" request gate. Each begin() supersedes every earlier ticket,
 * so a slow reply for a previous selection can be detected and dropped:
 *
 *   const ticket = gate.begin(gameId);
 *   const res = await ipcCall();
 *   if (!ticket.isLatest()) return; // a newer request (or invalidate) happened
 */
export interface LatestTicket<K> {
  readonly key: K;
  /** True while no newer begin()/invalidate() has happened. */
  isLatest(): boolean;
}

export interface LatestGate<K> {
  begin(key: K): LatestTicket<K>;
  /** Drop every in-flight ticket (e.g. on unmount or when the view closes). */
  invalidate(): void;
  /** Key of the most recent begin(), or undefined after invalidate(). */
  currentKey(): K | undefined;
}

export function createLatestGate<K>(): LatestGate<K> {
  let generation = 0;
  let current: K | undefined;
  return {
    begin(key: K) {
      generation += 1;
      current = key;
      const mine = generation;
      return { key, isLatest: () => mine === generation };
    },
    invalidate() {
      generation += 1;
      current = undefined;
    },
    currentKey: () => current,
  };
}
