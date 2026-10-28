import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { memoryCache } from '../core/cache.js';
import type { HttpRequest, HttpResponse, HttpTransport, ProviderLogger } from '../core/types.js';
import { createHltbProvider, HLTB_BASE_URL, HLTB_CACHE_TTL_MS, type HltbTimes } from './provider.js';
import { extractChunkPaths, extractSearchApi } from './discovery.js';
import { hltbCacheKey, normalizeTitle, secondsToMinutes } from './titles.js';

/** DUN-043: real HowLongToBeat record for Hollow Knight (comp_* in SECONDS). */
const FIXTURE = JSON.parse(fs.readFileSync(new URL('./hltb.fixture.json', import.meta.url), 'utf-8')) as {
  websiteHours: Record<string, string>;
  data: Array<{ game_name: string; comp_main: number; comp_plus: number; comp_100: number }>;
};
/** DUN-132: real site responses (homepage, search chunk excerpt, init with token redacted, trimmed search). */
const FLOW = JSON.parse(fs.readFileSync(new URL('./hltb.flow.fixture.json', import.meta.url), 'utf-8')) as {
  searchChunkPath: string;
  homepageHtml: string;
  searchChunk: string;
  init: { token: string };
  search: { count: number; data: Array<{ game_name: string; comp_main: number; comp_plus: number; comp_100: number }> };
};

const ok = (data: unknown): HttpResponse => ({ status: 200, headers: {}, data });
const status = (s: number, data: unknown = {}): HttpResponse => ({ status: s, headers: {}, data });

/** Offline fake of the site: homepage + search chunk from the fixture, other chunks 404, scripted /init and search replies. */
function fakeSite(o: { inits?: HttpResponse[]; searches?: Array<HttpResponse | Error>; html?: string; chunk?: string } = {}) {
  const inits = o.inits ?? [ok(FLOW.init)];
  const searches = o.searches ?? [ok(FLOW.search)];
  let i = 0;
  let s = 0;
  const calls: HttpRequest[] = [];
  const transport: HttpTransport = vi.fn(async (req: HttpRequest) => {
    calls.push(req);
    const u = new URL(req.url);
    if (req.method === 'POST') {
      const r = searches[Math.min(s++, searches.length - 1)]!;
      if (r instanceof Error) throw r;
      return r;
    }
    if (u.pathname === '/') return ok(o.html ?? FLOW.homepageHtml);
    if (u.pathname === FLOW.searchChunkPath) return ok(o.chunk ?? FLOW.searchChunk);
    if (u.pathname.startsWith('/_next/')) return status(404, 'Not Found');
    if (u.pathname.endsWith('/init')) return inits[Math.min(i++, inits.length - 1)]!;
    throw new Error(`unexpected GET ${req.url}`);
  });
  const posts = () => calls.filter((c) => c.method === 'POST');
  const initCalls = () => calls.filter((c) => c.url.includes('/init'));
  const homeCalls = () => calls.filter((c) => new URL(c.url).pathname === '/');
  return { transport, calls, posts, initCalls, homeCalls };
}

let clock = 1_800_000_000_000;
const now = () => clock;
function make(site = fakeSite(), extra: { enabled?: () => boolean; logger?: ProviderLogger } = {}) {
  const cache = memoryCache<HltbTimes>(now);
  const provider = createHltbProvider({ transport: site.transport, enabled: extra.enabled ?? (() => true), cache, now, ...(extra.logger ? { logger: extra.logger } : {}) });
  return { site, cache, provider };
}

beforeEach(() => { clock = 1_800_000_000_000; });

describe('gating', () => {
  it('disabled: PROVIDER_DISABLED with zero requests and no cache read', async () => {
    const site = fakeSite();
    const cache = memoryCache<HltbTimes>(now);
    const get = vi.spyOn(cache, 'get');
    const p = createHltbProvider({ transport: site.transport, enabled: () => false, cache });
    expect(await p.getTimes('Hollow Knight')).toEqual({ ok: false, code: 'PROVIDER_DISABLED', message: 'hltb is disabled' });
    expect(site.transport).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('a throwing or non-boolean flag source counts as disabled', async () => {
    const site = fakeSite();
    const p1 = createHltbProvider({ transport: site.transport, enabled: () => { throw new Error('settings down'); } });
    const p2 = createHltbProvider({ transport: site.transport, enabled: () => 'yes' as unknown as boolean });
    expect((await p1.getTimes('x')).ok).toBe(false);
    expect(await p2.getTimes('x')).toMatchObject({ code: 'PROVIDER_DISABLED' });
    expect(site.transport).not.toHaveBeenCalled();
  });
});

describe('cache', () => {
  it('fresh hit makes no request; miss fetches, converts seconds -> minutes, stamps and caches', async () => {
    const { site, cache, provider } = make();
    cache.set(hltbCacheKey('Cached Game'), { mainStory: 1, mainExtra: 2, completionist: 3 });
    expect(await provider.getTimes('  cached   GAME ')).toEqual({ ok: true, value: { mainStory: 1, mainExtra: 2, completionist: 3 } });
    expect(site.transport).not.toHaveBeenCalled();

    const r = await provider.getTimes('Hollow Knight');
    const [hk] = FLOW.search.data;
    expect(r).toMatchObject({ ok: true, value: { mainStory: secondsToMinutes(hk!.comp_main), source: 'hltb', fetchedAt: new Date(clock).toISOString() } });
    await provider.getTimes('hollow knight');
    expect(site.posts()).toHaveLength(1);
  });

  it('expired entry is refetched; on failure the stale entry is returned with stale: true', async () => {
    const site = fakeSite({ searches: [new Error('network down')] });
    const { cache, provider } = make(site);
    cache.set(hltbCacheKey('Old Game'), { mainStory: 9, mainExtra: 9, completionist: 9 });
    clock += HLTB_CACHE_TTL_MS + 1;
    expect(await provider.getTimes('Old Game')).toEqual({ ok: true, stale: true, value: { mainStory: 9, mainExtra: 9, completionist: 9 } });
    expect(site.posts()).toHaveLength(1);
  });

  it('cache read/write failures are logged misses, never failures', async () => {
    const warn = vi.fn();
    const site = fakeSite();
    const provider = createHltbProvider({
      transport: site.transport, enabled: () => true, now,
      cache: { get: () => { throw new Error('disk'); }, set: async () => { throw new Error('disk full'); } },
      logger: { info: () => {}, warn },
    });
    expect(await provider.getTimes('Hollow Knight')).toMatchObject({ ok: true });
    expect(warn.mock.calls.map(([o]) => (o as { op?: string }).op)).toEqual(expect.arrayContaining(['cache-read', 'cache-write']));
  });

  it('works without a cache', async () => {
    const site = fakeSite();
    const provider = createHltbProvider({ transport: site.transport, enabled: () => true });
    expect(await provider.getTimes('Hollow Knight')).toMatchObject({ ok: true });
    expect(await provider.getTimes('Hollow Knight')).toMatchObject({ ok: true });
    expect(site.posts()).toHaveLength(2);
  });
});

describe('DUN-043 / DUN-105: units, titles, typed failures', () => {
  it('comp_* are seconds: the real Hollow Knight record matches the site hours', async () => {
    const [hk] = FIXTURE.data;
    expect(FIXTURE.websiteHours).toEqual({ 'Main Story': '27 Hours', 'Main + Sides': '41½ Hours', Completionist: '65½ Hours' });
    expect(hk!.comp_main / 3600).toBeCloseTo(27, 0);
    const { provider } = make(fakeSite({ searches: [ok({ data: FIXTURE.data })] }));
    expect(await provider.getTimes('Hollow Knight')).toMatchObject({ ok: true, value: { mainStory: 1618, mainExtra: 2498, completionist: 3940 } });
  });

  it('secondsToMinutes rounds and treats junk as 0', () => {
    expect([secondsToMinutes(90), secondsToMinutes('3600'), secondsToMinutes(-5), secondsToMinutes(undefined), secondsToMinutes('x')]).toEqual([2, 60, 0, 0, 0]);
  });

  it('cache keys: distinct non-ASCII titles differ; case/whitespace/NFKC collapse', () => {
    expect(hltbCacheKey('大神')).not.toBe(hltbCacheKey('ペルソナ5'));
    expect(hltbCacheKey('大神')).toMatch(/^[0-9a-f]{64}$/);
    expect(normalizeTitle('  Hollow   KNIGHT ')).toBe('hollow knight');
    expect(hltbCacheKey('ＡＢＣ')).toBe(hltbCacheKey('abc'));
  });

  it('network error / bad shape -> PROVIDER_UNAVAILABLE; empty list -> PROVIDER_NOT_FOUND', async () => {
    expect(await make(fakeSite({ searches: [new Error('down')] })).provider.getTimes('a')).toEqual({ ok: false, code: 'PROVIDER_UNAVAILABLE', message: 'HowLongToBeat is unavailable' });
    expect(await make(fakeSite({ searches: [ok({ unexpected: true })] })).provider.getTimes('b')).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(await make(fakeSite({ searches: [ok({ ...FLOW.search, count: 0, data: [] })] })).provider.getTimes('c')).toEqual({ ok: false, code: 'PROVIDER_NOT_FOUND', message: 'Game not found on HowLongToBeat' });
  });
});

describe('DUN-132: token-gated search discovered from the site bundle', () => {
  it('finds the init and search paths in the real homepage + chunk', () => {
    const chunks = extractChunkPaths(FLOW.homepageHtml);
    expect(chunks).toContain(FLOW.searchChunkPath);
    expect(chunks.every((c) => c.startsWith('/_next/static/chunks/'))).toBe(true);
    expect(extractSearchApi(FLOW.searchChunk)).toEqual({ initPath: '/api/search/site/init', searchPath: '/api/search/site' });
    expect(extractSearchApi('fetch("/api/user",{method:"GET"})')).toBeNull();
  });

  it('falls back to the POST-with-x-auth-token call when the sibling path is not quoted alone', () => {
    const js = 'a("/api/q9/init?t="+Date.now());fetch("/api/q9/run",{method:"POST",headers:{"x-auth-token":t}})';
    expect(extractSearchApi(js)).toEqual({ initPath: '/api/q9/init', searchPath: '/api/q9/run' });
    expect(extractSearchApi('a("/api/q9/init?t=1")')).toBeNull();
  });

  it('scans the live load order: the search chunk is the 2nd eager chunk, then discovery stops', async () => {
    const chunks = extractChunkPaths(FLOW.homepageHtml);
    expect(chunks.indexOf(FLOW.searchChunkPath)).toBe(1);
    const { site, provider } = make();
    await provider.getTimes('Hollow Knight');
    const chunkGets = site.calls.map((c) => new URL(c.url).pathname).filter((p) => p.startsWith('/_next/'));
    expect(chunkGets).toEqual(chunks.slice(0, 2));
  });

  it('reads the Turbopack otherChunks bootstrap when the chunk has no <script> tag', async () => {
    const bootstrapOnly = FLOW.homepageHtml.replace(/<script[^>]+src="[^"]*"[^>]*><\/script>/g, '');
    expect(bootstrapOnly).not.toContain('src="/_next/');
    expect(extractChunkPaths(bootstrapOnly)).toContain(FLOW.searchChunkPath);
    const { site, provider } = make(fakeSite({ html: bootstrapOnly }));
    expect(await provider.getTimes('Hollow Knight')).toMatchObject({ ok: true });
    expect(site.posts()[0]!.url).toBe(`${HLTB_BASE_URL}/api/search/site`);
  });

  it('follows a rotated endpoint without code changes', () => {
    const rotated = FLOW.searchChunk.replaceAll('/api/search/site', '/api/lookup/v9');
    expect(extractSearchApi(rotated)).toEqual({ initPath: '/api/lookup/v9/init', searchPath: '/api/lookup/v9' });
  });

  it('discovers, mints a token, and POSTs the search with it (real Hollow Knight shape)', async () => {
    const { site, provider } = make();
    const r = await provider.getTimes('Hollow Knight');
    expect(r.ok && r.value.mainStory / 60).toBeCloseTo(27, 0);
    expect(site.homeCalls()).toHaveLength(1);
    expect(site.initCalls()).toHaveLength(1);
    expect(site.initCalls()[0]!.url).toBe(`${HLTB_BASE_URL}/api/search/site/init?t=${clock}`);
    const [post] = site.posts();
    expect(post!.url).toBe(`${HLTB_BASE_URL}/api/search/site`);
    expect(post!.body).toMatchObject({ searchType: 'games', searchTerms: ['Hollow', 'Knight'] });
    expect(post!.headers).toMatchObject({ 'x-auth-token': FLOW.init.token, Origin: HLTB_BASE_URL, Referer: `${HLTB_BASE_URL}/` });
    // The token is minted and used with the same User-Agent; defaults applied by the guard.
    expect(post!.headers!['User-Agent']).toBe(site.initCalls()[0]!.headers!['User-Agent']);
    expect(post).toMatchObject({ timeoutMs: 10_000, responseType: 'json' });
  });

  it('reuses the cached endpoint and token; both expire on their TTLs', async () => {
    const { site, provider } = make();
    await provider.getTimes('Hollow Knight');
    await provider.getTimes('Celeste');
    expect(site.homeCalls()).toHaveLength(1);
    expect(site.initCalls()).toHaveLength(1);
    clock += 11 * 60 * 1000; // token TTL 10 min
    await provider.getTimes('Hades');
    expect(site.initCalls()).toHaveLength(2);
    expect(site.homeCalls()).toHaveLength(1);
    clock += 7 * 60 * 60 * 1000; // endpoint TTL 6 h
    await provider.getTimes('Hades II');
    expect(site.homeCalls()).toHaveLength(2);
    provider.resetSession();
    await provider.getTimes('Tunic');
    expect(site.homeCalls()).toHaveLength(3);
  });

  it('echoes a honeypot pair only when init issues one', async () => {
    const { site, provider } = make(fakeSite({ inits: [ok({ token: 'tok-hp', hpKey: 'ign_abc', hpVal: 'v123' })] }));
    await provider.getTimes('Hollow Knight');
    const [post] = site.posts();
    expect((post!.body as Record<string, unknown>).ign_abc).toBe('v123');
    expect(post!.headers).toMatchObject({ 'x-auth-token': 'tok-hp', 'x-hp-key': 'ign_abc', 'x-hp-val': 'v123' });
  });

  it('on 403 refreshes the token once and retries', async () => {
    const { site, provider } = make(fakeSite({ inits: [ok({ token: 'expired' }), ok({ token: 'fresh' })], searches: [status(403, { error: 'IFW-U01' }), ok(FLOW.search)] }));
    expect(await provider.getTimes('Hollow Knight')).toMatchObject({ ok: true });
    expect(site.posts().map((p) => p.headers!['x-auth-token'])).toEqual(['expired', 'fresh']);
    expect(site.initCalls()).toHaveLength(2);
    expect(site.homeCalls()).toHaveLength(1);
  });

  it('on 404 rediscovers the endpoint once and retries', async () => {
    const { site, provider } = make(fakeSite({ searches: [status(404, 'Not Found'), ok(FLOW.search)] }));
    expect(await provider.getTimes('Hollow Knight')).toMatchObject({ ok: true });
    expect(site.homeCalls()).toHaveLength(2);
    expect(site.posts()).toHaveLength(2);
  });

  it('a 404 on init rediscovers the endpoint', async () => {
    const { site, provider } = make(fakeSite({ inits: [status(404), ok(FLOW.init)] }));
    expect(await provider.getTimes('Hollow Knight')).toMatchObject({ ok: true });
    expect(site.homeCalls()).toHaveLength(2);
  });

  it('a refresh that still fails is PROVIDER_UNAVAILABLE after exactly one retry', async () => {
    const { site, provider } = make(fakeSite({ searches: [status(403, { error: 'IFW-U01' })] }));
    expect(await provider.getTimes('Hollow Knight')).toMatchObject({ ok: false, code: 'PROVIDER_UNAVAILABLE' });
    expect(site.posts()).toHaveLength(2);
    expect(site.initCalls()).toHaveLength(2);
  });

  it('a failed token refresh is PROVIDER_UNAVAILABLE', async () => {
    const { site, provider } = make(fakeSite({ inits: [ok({ token: 'expired' }), status(403)], searches: [status(403)] }));
    expect(await provider.getTimes('Hollow Knight')).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(site.posts()).toHaveLength(1);
    expect(site.initCalls()).toHaveLength(2);
  });

  it('init without a token, a failed init request, or a bundle without the search client: nothing is searched', async () => {
    const a = make(fakeSite({ inits: [ok({ message: 'nope' })] }));
    expect(await a.provider.getTimes('x')).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(a.site.posts()).toHaveLength(0);
    const b = make(fakeSite({ chunk: 'console.log("no search here")' }));
    expect(await b.provider.getTimes('x')).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(b.site.initCalls()).toHaveLength(0);
    const c = make(fakeSite({ html: '' }));
    c.site.transport = vi.fn(async () => { throw new Error('down'); });
    const p = createHltbProvider({ transport: c.site.transport, enabled: () => true });
    expect(await p.getTimes('x')).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('a 429 is PROVIDER_UNAVAILABLE without a refresh', async () => {
    const { site, provider } = make(fakeSite({ searches: [status(429)] }));
    expect(await provider.getTimes('Hollow Knight')).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(site.posts()).toHaveLength(1);
  });

  it('never logs the auth token', async () => {
    const lines: string[] = [];
    const logger: ProviderLogger = { info: (o, m) => lines.push(JSON.stringify(o) + m), warn: (o, m) => lines.push(JSON.stringify(o) + m) };
    const site = fakeSite({ inits: [ok({ token: 'SECRET-TOKEN-123' })], searches: [new Error('socket hang up token=SECRET-TOKEN-123')] });
    await make(site, { logger }).provider.getTimes('Hollow Knight');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain('SECRET-TOKEN-123');
  });

  it('only ever talks to howlongtobeat.com over https', async () => {
    const { site, provider } = make();
    await provider.getTimes('Hollow Knight');
    expect(site.calls.every((c) => new URL(c.url).origin === HLTB_BASE_URL)).toBe(true);
  });
});
