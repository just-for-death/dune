import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'node:crypto';
import { dataDir } from '../utils/path.js';
import { logger, redactText } from '../middleware/logging.js';

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function cacheDir(): string {
  return path.join(dataDir(), 'hltb-cache');
}

export interface HLTBTimes {
  mainStory: number;
  mainExtra: number;
  completionist: number;
  source?: string;
  fetchedAt?: string;
}

/** Typed failure (DUN-105): no match vs. the service could not be reached/read. */
export type HLTBFailureCode = 'HLTB_NOT_FOUND' | 'HLTB_UNAVAILABLE';

export interface HLTBResponse {
  success: boolean;
  times?: HLTBTimes;
  message?: string;
  stale?: boolean;
  code?: HLTBFailureCode;
}

function ensureCacheDir(): void {
  const dir = cacheDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Cache identity of a title: NFKC, trimmed, whitespace collapsed, lower-cased. */
export function normalizeTitle(gameName: string): string {
  return gameName.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * DUN-105: sha256 of the normalized title, so every distinct title (including
 * non-ASCII ones like '大神' vs 'ペルソナ5') gets its own cache file.
 */
export function getCachePath(gameName: string): string {
  const key = createHash('sha256').update(normalizeTitle(gameName)).digest('hex');
  return path.join(cacheDir(), `${key}.json`);
}

function logHltbError(op: string, err: unknown): void {
  const e = err as { message?: unknown; code?: unknown; response?: { status?: unknown } };
  logger.warn({
    op,
    message: redactText(typeof e?.message === 'string' ? e.message : String(err)),
    code: typeof e?.code === 'string' ? e.code : undefined,
    status: typeof e?.response?.status === 'number' ? e.response.status : undefined,
  }, 'HowLongToBeat error');
}

/**
 * DUN-043: HowLongToBeat's comp_main / comp_plus / comp_100 are SECONDS
 * (Hollow Knight: comp_main 97100 = 26.97 h, shown as "27 Hours"; see
 * hltb.fixture.json). HLTBTimes is minutes.
 */
export function secondsToMinutes(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n / 60) : 0;
}

export function readCache(gameName: string, allowStale = false): HLTBTimes | null {
  try {
    ensureCacheDir();
    const cachePath = getCachePath(gameName);
    if (!fs.existsSync(cachePath)) return null;

    const stats = fs.statSync(cachePath);
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    if (Date.now() - stats.mtimeMs > CACHE_TTL_MS && !allowStale) return null;

    return data.times ?? null;
  } catch (err) {
    logHltbError('cache-read', err);
    return null;
  }
}

export function writeCache(gameName: string, times: HLTBTimes): void {
  try {
    ensureCacheDir();
    const cachePath = getCachePath(gameName);
    fs.writeFileSync(cachePath, JSON.stringify({ times, source: 'hltb', fetchedAt: new Date().toISOString(), cachedAt: Date.now() }), 'utf-8');
  } catch (err) {
    // A failed cache write never fails the lookup, but it is not silent.
    logHltbError('cache-write', err);
  }
}

type SearchResult = { ok: true; times: HLTBTimes } | { ok: false; code: HLTBFailureCode };

async function searchHLTB(gameName: string): Promise<SearchResult> {
  let data: unknown;
  try {
    const searchResponse = await axios.post(
      'https://howlongtobeat.com/api/search',
      {
        searchType: 'games',
        searchTerms: gameName.split(' '),
        searchPage: 1,
        size: 5,
        searchOptions: {
          games: { userId: 0, platform: '', sortCategory: 'popular', rangeCategory: 'main', rangeTime: { min: 0, max: 0 }, gameplay: { perspective: '', flow: '', genre: '' }, modifier: '' },
          users: { sortCategory: 'postcount' },
          filter: '',
          sort: 0,
          randomizer: 0
        }
      },
      { timeout: 10000 }
    );
    data = searchResponse.data;
  } catch (err) {
    logHltbError('search', err);
    return { ok: false, code: 'HLTB_UNAVAILABLE' };
  }

  const list = (data as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(list)) {
    logHltbError('search', new Error('Unexpected HowLongToBeat response shape'));
    return { ok: false, code: 'HLTB_UNAVAILABLE' };
  }
  if (list.length === 0) return { ok: false, code: 'HLTB_NOT_FOUND' };

  const game = list[0] as Record<string, unknown>;
  return {
    ok: true,
    times: {
      mainStory: secondsToMinutes(game.comp_main),
      mainExtra: secondsToMinutes(game.comp_plus),
      completionist: secondsToMinutes(game.comp_100),
    },
  };
}

export async function getHLTBTimes(gameName: string): Promise<HLTBResponse> {
  const cached = readCache(gameName);
  if (cached) {
    return { success: true, times: cached };
  }

  const result = await searchHLTB(gameName);
  if (result.ok) {
    const stamped = { ...result.times, source: 'hltb', fetchedAt: new Date().toISOString() };
    writeCache(gameName, stamped);
    return { success: true, times: stamped };
  }

  const stale = readCache(gameName, true);
  if (stale) {
    return { success: true, times: stale, stale: true, message: 'Using cached HowLongToBeat data' };
  }

  return result.code === 'HLTB_NOT_FOUND'
    ? { success: false, code: result.code, message: 'Game not found on HowLongToBeat' }
    : { success: false, code: result.code, message: 'HowLongToBeat is unavailable' };
}

export async function bulkFetchHLTB(gameNames: string[]): Promise<Map<string, HLTBTimes>> {
  const results = new Map<string, HLTBTimes>();
  
  for (const name of gameNames) {
    const cached = readCache(name);
    if (cached) {
      results.set(name, cached);
      continue;
    }
    
    const response = await getHLTBTimes(name);
    if (response.success && response.times) {
      results.set(name, response.times);
    }
    
    await new Promise(r => setTimeout(r, 200));
  }
  
  return results;
}
