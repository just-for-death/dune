import type { CacheEntry, ProviderCache } from './types.js';

/** In-memory ProviderCache (default for tests and short-lived callers). */
/** Synchronous in-memory cache; assignable to ProviderCache<T>. */
export interface MemoryCache<T> extends ProviderCache<T> {
  get(key: string): CacheEntry<T> | null;
  set(key: string, value: T): void;
  clear(): void;
}

export function memoryCache<T>(now: () => number = Date.now): MemoryCache<T> {
  const map = new Map<string, CacheEntry<T>>();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => { map.set(key, { value, storedAt: now() }); },
    clear: () => map.clear(),
  };
}

export function isFresh(entry: CacheEntry<unknown>, ttlMs: number, now: number): boolean {
  return now - entry.storedAt < ttlMs;
}
