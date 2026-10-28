import { createHash } from 'node:crypto';

/** Cache identity of a title: NFKC, trimmed, whitespace collapsed, lower-cased. */
export function normalizeTitle(gameName: string): string {
  return gameName.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * DUN-105: sha256 of the normalized title, so every distinct title (including
 * non-ASCII ones like '大神' vs 'ペルソナ5') gets its own cache entry.
 */
export function hltbCacheKey(gameName: string): string {
  return createHash('sha256').update(normalizeTitle(gameName)).digest('hex');
}

/**
 * DUN-043: HowLongToBeat's comp_main / comp_plus / comp_100 are SECONDS
 * (Hollow Knight: comp_main 97100 = 26.97 h, shown as "27 Hours"; see
 * hltb.fixture.json). HltbTimes is minutes.
 */
export function secondsToMinutes(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n / 60) : 0;
}
