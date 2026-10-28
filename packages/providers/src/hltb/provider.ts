import { isFresh } from '../core/cache.js';
import { failure, success, type ProviderResult } from '../core/errors.js';
import { gated } from '../core/gating.js';
import { createGuardedClient, type GuardedRequest } from '../core/guard.js';
import { safeErrorMessage } from '../core/redact.js';
import { noopLogger, type EnabledSource, type HttpResponse, type HttpTransport, type ProviderCache, type ProviderLogger } from '../core/types.js';
import { extractChunkPaths, extractSearchApi, type HltbSearchApi } from './discovery.js';
import { hltbCacheKey, secondsToMinutes } from './titles.js';

export const HLTB_BASE_URL = 'https://howlongtobeat.com';
export const HLTB_HOSTS = ['howlongtobeat.com'] as const;
// The token is bound to the User-Agent that minted it: use one UA throughout.
export const HLTB_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
export const HLTB_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const API_TTL_MS = 6 * 60 * 60 * 1000;
const TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_CHUNKS_SCANNED = 25;

/** Minutes. `source`/`fetchedAt` are stamped on fresh lookups. */
export interface HltbTimes {
  mainStory: number;
  mainExtra: number;
  completionist: number;
  source?: string;
  fetchedAt?: string;
}

/** ok (maybe `stale`), or PROVIDER_DISABLED | PROVIDER_NOT_FOUND | PROVIDER_UNAVAILABLE. */
export type HltbResult = ProviderResult<HltbTimes>;

export interface HltbProviderOptions {
  transport: HttpTransport;
  enabled: EnabledSource;
  /** Keyed by hltbCacheKey(title). Omit for no persistent cache. */
  cache?: ProviderCache<HltbTimes>;
  logger?: ProviderLogger;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
}

export interface HltbProvider {
  /** Cache first; on a miss the token-gated search; on failure a stale cache entry if any. */
  getTimes(gameName: string): Promise<HltbResult>;
  /** Forget the discovered endpoint and token (tests; a forced rediscovery). */
  resetSession(): void;
}

interface Session { token: string; hpKey?: string; hpVal?: string }
type Step<T> = { ok: true; value: T } | { ok: false; retry: 'token' | 'api' | null };
type Search = { ok: true; times: HltbTimes } | { ok: false; code: 'PROVIDER_NOT_FOUND' | 'PROVIDER_UNAVAILABLE' };

function retryFor(status: number): 'token' | 'api' | null {
  return status === 403 ? 'token' : status === 404 ? 'api' : null;
}

function searchBody(gameName: string, session: Session): Record<string, unknown> {
  const body: Record<string, unknown> = {
    searchType: 'games',
    searchTerms: gameName.trim().split(/\s+/),
    searchPage: 1,
    size: 5,
    searchOptions: {
      games: { userId: 0, platform: '', sortCategory: 'popular', rangeCategory: 'main', rangeTime: { min: null, max: null }, gameplay: { perspective: '', flow: '', genre: '' }, year: '', modifier: '' },
      users: { sortCategory: 'postcount' },
      lists: { sortCategory: 'follows' },
      filter: '',
      sort: 0,
      randomizer: 0,
    },
    useCache: true,
  };
  if (session.hpKey && session.hpVal) body[session.hpKey] = session.hpVal;
  return body;
}

/**
 * GET the homepage, scan its eager chunks for the search client, GET
 * `<init>?t=<ms>` for a token, then POST the search with `x-auth-token`.
 * Paths (6 h) and token (10 min) live in this instance's memory; a 403
 * refreshes the token once, a 404 rediscovers the endpoint once.
 * Nothing runs until getTimes is called on an enabled provider.
 */
export function createHltbProvider(opts: HltbProviderOptions): HltbProvider {
  const logger = opts.logger ?? noopLogger;
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? HLTB_CACHE_TTL_MS;
  let apiCache: { api: HltbSearchApi; at: number } | null = null;
  let sessionCache: { session: Session; at: number } | null = null;
  const client = createGuardedClient({
    provider: 'hltb',
    hosts: HLTB_HOSTS,
    transport: opts.transport,
    logger,
    secrets: () => [sessionCache?.session.token, sessionCache?.session.hpVal],
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });

  const logError = (op: string, err: unknown, status?: number) => {
    logger.warn({ provider: 'hltb', op, message: safeErrorMessage(err, [sessionCache?.session.token]), ...(status !== undefined ? { status } : {}) }, 'HowLongToBeat error');
  };

  /** HTTP that never throws: the response, or null when the request itself failed (already logged). */
  async function http(urlPath: string, init: GuardedRequest): Promise<HttpResponse | null> {
    try {
      return await client.request(new URL(urlPath, HLTB_BASE_URL).toString(), {
        ...init,
        headers: { 'User-Agent': HLTB_USER_AGENT, Referer: `${HLTB_BASE_URL}/`, ...init.headers },
      });
    } catch {
      return null;
    }
  }

  async function discover(): Promise<HltbSearchApi | null> {
    const home = await http('/', { responseType: 'text' });
    if (!home || home.status !== 200 || typeof home.data !== 'string') {
      logError('discover-home', new Error(`HowLongToBeat homepage unavailable (status ${home?.status ?? 'none'})`));
      return null;
    }
    for (const chunk of extractChunkPaths(home.data).slice(0, MAX_CHUNKS_SCANNED)) {
      const res = await http(chunk, { responseType: 'text' });
      if (!res || res.status !== 200 || typeof res.data !== 'string') continue;
      const api = extractSearchApi(res.data);
      if (api) {
        logger.info({ provider: 'hltb', op: 'discover', initPath: api.initPath, searchPath: api.searchPath }, 'HowLongToBeat search endpoint discovered');
        return api;
      }
    }
    logError('discover', new Error('HowLongToBeat search endpoint not found in site bundle'));
    return null;
  }

  async function getApi(): Promise<Step<HltbSearchApi>> {
    if (apiCache && now() - apiCache.at < API_TTL_MS) return { ok: true, value: apiCache.api };
    const api = await discover();
    if (!api) return { ok: false, retry: null };
    apiCache = { api, at: now() };
    return { ok: true, value: api };
  }

  async function getSession(api: HltbSearchApi): Promise<Step<Session>> {
    if (sessionCache && now() - sessionCache.at < TOKEN_TTL_MS) return { ok: true, value: sessionCache.session };
    const res = await http(`${api.initPath}?t=${now()}`, { responseType: 'json' });
    if (!res) return { ok: false, retry: null };
    const body = res.data as { token?: unknown; hpKey?: unknown; hpVal?: unknown } | null;
    if (res.status !== 200 || typeof body?.token !== 'string' || body.token.length === 0) {
      logError('token', new Error('HowLongToBeat token init failed'), res.status);
      // A 404 here means the init path itself rotated.
      return { ok: false, retry: retryFor(res.status) };
    }
    // Older builds also issued a honeypot pair; echo it only when issued.
    const session: Session = typeof body.hpKey === 'string' && typeof body.hpVal === 'string'
      ? { token: body.token, hpKey: body.hpKey, hpVal: body.hpVal }
      : { token: body.token };
    sessionCache = { session, at: now() };
    return { ok: true, value: session };
  }

  async function searchOnce(gameName: string): Promise<Step<unknown>> {
    const api = await getApi();
    if (!api.ok) return api;
    const session = await getSession(api.value);
    if (!session.ok) return session;
    const s = session.value;
    const res = await http(api.value.searchPath, {
      method: 'POST',
      responseType: 'json',
      body: searchBody(gameName, s),
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Origin: HLTB_BASE_URL,
        'x-auth-token': s.token,
        ...(s.hpKey && s.hpVal ? { 'x-hp-key': s.hpKey, 'x-hp-val': s.hpVal } : {}),
      },
    });
    if (!res) return { ok: false, retry: null };
    if (res.status !== 200) {
      logError('search', new Error('HowLongToBeat search failed'), res.status);
      return { ok: false, retry: retryFor(res.status) };
    }
    return { ok: true, value: res.data };
  }

  async function search(gameName: string): Promise<Search> {
    let step = await searchOnce(gameName);
    if (!step.ok && step.retry) {
      // Refresh once: a 403 means the token expired, a 404 that the endpoint moved.
      sessionCache = null;
      if (step.retry === 'api') apiCache = null;
      step = await searchOnce(gameName);
    }
    if (!step.ok) return { ok: false, code: 'PROVIDER_UNAVAILABLE' };
    const list = (step.value as { data?: unknown } | null | undefined)?.data;
    if (!Array.isArray(list)) {
      logError('search', new Error('Unexpected HowLongToBeat response shape'));
      return { ok: false, code: 'PROVIDER_UNAVAILABLE' };
    }
    if (list.length === 0) return { ok: false, code: 'PROVIDER_NOT_FOUND' };
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

  async function cacheGet(key: string) {
    if (!opts.cache) return null;
    try {
      return await opts.cache.get(key);
    } catch (err) {
      logError('cache-read', err);
      return null;
    }
  }

  return {
    getTimes: (gameName) => gated('hltb', opts.enabled, async () => {
      const key = hltbCacheKey(gameName);
      const cached = await cacheGet(key);
      if (cached && isFresh(cached, ttlMs, now())) return success(cached.value);

      const result = await search(gameName);
      if (result.ok) {
        const stamped: HltbTimes = { ...result.times, source: 'hltb', fetchedAt: new Date(now()).toISOString() };
        try {
          await opts.cache?.set(key, stamped);
        } catch (err) {
          // A failed cache write never fails the lookup, but it is not silent.
          logError('cache-write', err);
        }
        return success(stamped);
      }
      if (cached) return success(cached.value, true);
      return result.code === 'PROVIDER_NOT_FOUND'
        ? failure('PROVIDER_NOT_FOUND', 'Game not found on HowLongToBeat')
        : failure('PROVIDER_UNAVAILABLE', 'HowLongToBeat is unavailable');
    }),
    resetSession() {
      apiCache = null;
      sessionCache = null;
    },
  };
}
