/**
 * HowLongToBeat for the server: a thin adapter over @dune/providers (which
 * owns the discovery / token / search flow, DUN-132). The server supplies the
 * axios transport, its file cache (data/hltb-cache/<sha256>.json, DUN-105;
 * file mtime = stored time, 30-day TTL, stale fallback) and pino, and keeps
 * the /api/hltb route contract.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHltbProvider, hltbCacheKey, type CacheEntry, type HltbTimes, type ProviderCache } from '@dune/providers';
import { database } from '../db/index.js';
import { ApiError } from '../utils/apiError.js';
import { dataDir } from '../utils/path.js';
import { logger, redactText } from '../middleware/logging.js';
import { axiosTransport } from './providerTransport.js';

export type HLTBTimes = HltbTimes;

/** Typed failure (DUN-105): no match vs. unreachable/unreadable. Disabled is not a lookup result: 403 PROVIDER_DISABLED. */
export type HLTBFailureCode = 'HLTB_NOT_FOUND' | 'HLTB_UNAVAILABLE';

export interface HLTBResponse {
  success: boolean;
  times?: HLTBTimes;
  message?: string;
  stale?: boolean;
  code?: HLTBFailureCode;
}

function cacheDir(): string {
  return path.join(dataDir(), 'hltb-cache');
}

/** Cache file of a title (sha256 of the normalized title, so non-ASCII titles never collide). */
export function getCachePath(gameName: string): string {
  return path.join(cacheDir(), `${hltbCacheKey(gameName)}.json`);
}

function logCacheError(op: string, err: unknown): void {
  logger.warn({ op, message: redactText(err instanceof Error ? err.message : String(err)) }, 'HowLongToBeat error');
}

/** File-backed ProviderCache, keyed by hltbCacheKey(). A read error is a logged miss; a write error is logged. */
export const hltbFileCache: ProviderCache<HLTBTimes> = {
  get(key: string): CacheEntry<HLTBTimes> | null {
    try {
      const file = path.join(cacheDir(), `${key}.json`);
      if (!fs.existsSync(file)) return null;
      const storedAt = fs.statSync(file).mtimeMs;
      const times = (JSON.parse(fs.readFileSync(file, 'utf-8')) as { times?: HLTBTimes }).times;
      return times ? { value: times, storedAt } : null;
    } catch (err) {
      logCacheError('cache-read', err);
      return null;
    }
  },
  set(key: string, times: HLTBTimes): void {
    try {
      fs.mkdirSync(cacheDir(), { recursive: true });
      fs.writeFileSync(path.join(cacheDir(), `${key}.json`), JSON.stringify({ times, source: 'hltb', fetchedAt: new Date().toISOString(), cachedAt: Date.now() }), 'utf-8');
    } catch (err) {
      logCacheError('cache-write', err);
    }
  },
};

/** Opt-in: only Settings.hltbEnabled === true lets a lookup (or a cache read) happen. */
export function hltbEnabled(): boolean {
  return database.getSettings().hltbEnabled === true;
}

const provider = createHltbProvider({ transport: axiosTransport, enabled: hltbEnabled, cache: hltbFileCache, logger });

/** Test hook: forget the discovered endpoint and token. */
export function resetHLTBSession(): void {
  provider.resetSession();
}

export async function getHLTBTimes(gameName: string): Promise<HLTBResponse> {
  const r = await provider.getTimes(gameName);
  if (r.ok) {
    return r.stale
      ? { success: true, times: r.value, stale: true, message: 'Using cached HowLongToBeat data' }
      : { success: true, times: r.value };
  }
  // Lead rule: every turned-off provider answers 403 { error, code: 'PROVIDER_DISABLED' } via ApiError.
  if (r.code === 'PROVIDER_DISABLED') throw new ApiError(403, 'PROVIDER_DISABLED', 'HowLongToBeat lookups are disabled (Settings.hltbEnabled)');
  return r.code === 'PROVIDER_NOT_FOUND'
    ? { success: false, code: 'HLTB_NOT_FOUND', message: 'Game not found on HowLongToBeat' }
    : { success: false, code: 'HLTB_UNAVAILABLE', message: 'HowLongToBeat is unavailable' };
}
