import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('axios');
import axios from 'axios';
import { HLTB_BASE_URL, hltbCacheKey, secondsToMinutes } from '@dune/providers';
import { getHLTBTimes, getCachePath, hltbEnabled, hltbFileCache, resetHLTBSession, type HLTBTimes } from './hltb.js';
import { database } from '../db/index.js';

const setHltbEnabled = (on: unknown) => database.saveSettings({ ...database.getSettings(), hltbEnabled: on as boolean });

/**
 * Server adapter tests (file cache, route contract, axios transport wiring).
 * The discovery/token/retry flow itself is tested offline in
 * packages/providers/src/hltb/hltb.test.ts.
 */
const writeCache = (name: string, times: HLTBTimes) => hltbFileCache.set(hltbCacheKey(name), times);
const readCache = (name: string) => (hltbFileCache.get(hltbCacheKey(name)) as { value: HLTBTimes } | null)?.value ?? null;

/**
 * DUN-043: real HowLongToBeat record for Hollow Knight (comp_* in SECONDS),
 * trimmed to the relevant fields; the site shows 27 h / 41½ h / 65½ h.
 */
const FIXTURE = JSON.parse(fs.readFileSync(new URL('./hltb.fixture.json', import.meta.url), 'utf-8')) as {
  websiteHours: Record<string, string>;
  data: Array<{ game_name: string; comp_main: number; comp_plus: number; comp_100: number }>;
};

/**
 * DUN-132: real site responses (homepage script tags, the search chunk excerpt,
 * the init body with its token redacted, and a trimmed search body).
 */
const FLOW = JSON.parse(fs.readFileSync(new URL('./hltb.flow.fixture.json', import.meta.url), 'utf-8')) as {
  searchChunkPath: string;
  homepageHtml: string;
  searchChunk: string;
  init: { token: string };
  search: { count: number; data: Array<{ game_name: string; comp_main: number; comp_plus: number; comp_100: number }> };
};

const HLTB_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-hltb-test-'));
const SETUP_DATA_DIR = process.env.DATA_DIR as string; // temp dir from src/test/setup.ts (DUN-005)
process.env.DATA_DIR = HLTB_TMP;
const postMock = vi.mocked(axios.post);
const getMock = vi.mocked(axios.get);

type Reply = { status: number; data: unknown };
const ok = (data: unknown): Reply => ({ status: 200, data });

/**
 * Serve the real homepage and bundle from the fixture; every other chunk is a
 * 404. `inits` are the successive /init replies (the last one repeats).
 */
function mockSite(inits: Reply[] = [ok(FLOW.init)], site = { html: FLOW.homepageHtml, chunk: FLOW.searchChunk }) {
  let i = 0;
  getMock.mockImplementation(async (url: string) => {
    const u = new URL(url);
    if (u.pathname === '/') return ok(site.html);
    if (u.pathname === FLOW.searchChunkPath) return ok(site.chunk);
    if (u.pathname.startsWith('/_next/')) return { status: 404, data: 'Not Found' };
    if (u.pathname.endsWith('/init')) return inits[Math.min(i++, inits.length - 1)];
    throw new Error(`unexpected GET ${url}`);
  });
}

const initCalls = () => getMock.mock.calls.filter(([url]) => String(url).includes('/init'));
const homeCalls = () => getMock.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/');
const CACHE_DIR = path.join(process.env.DATA_DIR as string, 'hltb-cache');

beforeEach(() => {
  setHltbEnabled(true);
  postMock.mockReset();
  getMock.mockReset();
  resetHLTBSession();
  mockSite();
  if (fs.existsSync(CACHE_DIR)) fs.rmSync(CACHE_DIR, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(CACHE_DIR)) fs.rmSync(CACHE_DIR, { recursive: true, force: true });
});

afterAll(() => {
  process.env.DATA_DIR = SETUP_DATA_DIR; // restore the temp dir, never unset (DUN-005)
  fs.rmSync(HLTB_TMP, { recursive: true, force: true });
});

function apiGame(overrides = {}) {
  // Seconds, like the real API: 20 h / 30 h / 50 h.
  return { comp_main: 72000, comp_plus: 108000, comp_100: 180000, ...overrides };
}

describe('Settings.hltbEnabled opt-in gate', () => {
  it('defaults to off', () => {
    database.saveSettings({ ...database.getSettings(), hltbEnabled: undefined as unknown as boolean });
    expect(database.getSettings().hltbEnabled).toBe(false);
    expect(hltbEnabled()).toBe(false);
  });

  it('disabled (false, missing, or truthy non-boolean): PROVIDER_DISABLED, zero requests, cache not read', async () => {
    writeCache('Gated Game', { mainStory: 1, mainExtra: 2, completionist: 3 });
    for (const off of [false, undefined, 'true', 1]) {
      setHltbEnabled(off);
      await expect(getHLTBTimes('Gated Game')).rejects.toMatchObject({ status: 403, code: 'PROVIDER_DISABLED', message: 'HowLongToBeat lookups are disabled (Settings.hltbEnabled)' });
    }
    expect(getMock).not.toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
    setHltbEnabled(true);
    expect(await getHLTBTimes('Gated Game')).toMatchObject({ success: true, times: { mainStory: 1 } });
  });
});

describe('Cache functions', () => {
  it('should write and read cache', () => {
    const times = { mainStory: 1200, mainExtra: 1800, completionist: 3000 };
    writeCache('Test Game', times);

    const cached = readCache('Test Game');
    expect(cached).toEqual(times);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('should return null for non-existent cache', () => {
    const cached = readCache('Non Existent Game');
    expect(cached).toBeNull();
  });

  it('should sanitize game name for cache file', () => {
    const times = { mainStory: 600, mainExtra: 900, completionist: 1200 };
    writeCache('Game: With Special/Chars*', times);

    const cached = readCache('Game: With Special/Chars*');
    expect(cached).toEqual(times);
  });

  it('should expire cache after TTL (refetched on the next lookup)', async () => {
    const times = { mainStory: 600, mainExtra: 900, completionist: 1200 };
    writeCache('Test Game TTL', times);
    const cachePath = getCachePath('Test Game TTL');
    const oldTime = Date.now() - 31 * 24 * 60 * 60 * 1000; // 31 days ago
    fs.utimesSync(cachePath, new Date(oldTime), new Date(oldTime));
    postMock.mockResolvedValue({ status: 200, data: { data: [apiGame()] } });

    const result = await getHLTBTimes('Test Game TTL');
    expect(result).toMatchObject({ success: true, times: { mainStory: 1200, source: 'hltb' } });
    expect(result.stale).toBeUndefined();
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(readCache('Test Game TTL')).toMatchObject({ mainStory: 1200 });
  });
});

describe('getHLTBTimes', () => {
  it('should return cached times without network', async () => {
    const times = { mainStory: 1200, mainExtra: 1800, completionist: 3000 };
    writeCache('Cached Game', times);

    const result = await getHLTBTimes('Cached Game');
    expect(result.success).toBe(true);
    expect(result.times).toEqual(times);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('should fetch, convert seconds to minutes, and cache on miss', async () => {
    postMock.mockResolvedValue({ status: 200, data: { data: [apiGame()] } });

    const result = await getHLTBTimes('Some Game');
    expect(result.success).toBe(true);
    expect(result.times).toMatchObject({ mainStory: 1200, mainExtra: 1800, completionist: 3000 });
    // Second call served from cache — still exactly one HTTP request
    await getHLTBTimes('Some Game');
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it('should return not found when API has no match', async () => {
    postMock.mockResolvedValue({ status: 200, data: { data: [] } });

    const result = await getHLTBTimes('This Game Does Not Exist 12345');
    expect(result).toMatchObject({ success: false, code: 'HLTB_NOT_FOUND', message: 'Game not found on HowLongToBeat' });
  });

  it('should return unavailable when the network fails', async () => {
    postMock.mockRejectedValue(new Error('network down'));

    const result = await getHLTBTimes('Any Game');
    expect(result).toMatchObject({ success: false, code: 'HLTB_UNAVAILABLE' });
  });

  it('should fall back to stale cache when the network fails', async () => {
    const times = { mainStory: 900, mainExtra: 1200, completionist: 1800 };
    writeCache('Stale Fallback Game', times);
    const cachePath = getCachePath('Stale Fallback Game');
    const oldTime = Date.now() - 31 * 24 * 60 * 60 * 1000;
    fs.utimesSync(cachePath, new Date(oldTime), new Date(oldTime));
    postMock.mockRejectedValue(new Error('network down'));

    const result = await getHLTBTimes('Stale Fallback Game');
    expect(result.success).toBe(true);
    expect(result.stale).toBe(true);
    expect(result.times).toEqual(times);
    expect(postMock).toHaveBeenCalledTimes(1);
  });
});


describe('DUN-043: HowLongToBeat units (real fixture)', () => {
  it('comp_* are seconds: the real Hollow Knight record matches the site hours', async () => {
    const [hk] = FIXTURE.data;
    expect(FIXTURE.websiteHours).toEqual({ 'Main Story': '27 Hours', 'Main + Sides': '41½ Hours', Completionist: '65½ Hours' });
    // 97100 s = 26.97 h (site: 27), 149852 s = 41.6 h (41½), 236390 s = 65.7 h (65½).
    expect(hk.comp_main / 3600).toBeCloseTo(27, 0);
    expect(Math.abs(hk.comp_plus / 3600 - 41.5)).toBeLessThan(0.5);
    expect(Math.abs(hk.comp_100 / 3600 - 65.5)).toBeLessThan(0.5);

    postMock.mockResolvedValue({ status: 200, data: { data: FIXTURE.data } });
    const result = await getHLTBTimes('Hollow Knight');
    expect(result.success).toBe(true);
    // HLTBTimes is minutes.
    expect(result.times).toMatchObject({ mainStory: 1618, mainExtra: 2498, completionist: 3940 });
  });

  it('secondsToMinutes rounds and treats junk as 0', () => {
    expect(secondsToMinutes(90)).toBe(2);
    expect(secondsToMinutes('3600')).toBe(60);
    expect(secondsToMinutes(-5)).toBe(0);
    expect(secondsToMinutes(undefined)).toBe(0);
    expect(secondsToMinutes('x')).toBe(0);
  });
});

describe('DUN-105: cache keys and typed failures', () => {
  it('distinct non-ASCII titles never share a cache file', () => {
    writeCache('大神', { mainStory: 1, mainExtra: 2, completionist: 3 });
    writeCache('ペルソナ5', { mainStory: 4, mainExtra: 5, completionist: 6 });
    expect(getCachePath('大神')).not.toBe(getCachePath('ペルソナ5'));
    expect(readCache('大神')).toEqual({ mainStory: 1, mainExtra: 2, completionist: 3 });
    expect(readCache('ペルソナ5')).toEqual({ mainStory: 4, mainExtra: 5, completionist: 6 });
    expect(path.basename(getCachePath('大神'))).toMatch(/^[0-9a-f]{64}\.json$/);
  });

  it('normalizes case/whitespace/NFKC to one key', () => {
    expect(getCachePath('Hollow Knight')).toBe(getCachePath(' hollow  knight'));
    expect(getCachePath('ＡＢＣ')).toBe(getCachePath('abc'));
  });

  it('surfaces HLTB_UNAVAILABLE on network errors and HLTB_NOT_FOUND on no match', async () => {
    postMock.mockRejectedValue(new Error('network down'));
    expect(await getHLTBTimes('Net Fail Game')).toMatchObject({ success: false, code: 'HLTB_UNAVAILABLE' });
    postMock.mockResolvedValue({ status: 200, data: { unexpected: true } });
    expect(await getHLTBTimes('Bad Shape Game')).toMatchObject({ success: false, code: 'HLTB_UNAVAILABLE' });
    postMock.mockResolvedValue({ status: 200, data: { data: [] } });
    expect(await getHLTBTimes('No Match Game')).toMatchObject({ success: false, code: 'HLTB_NOT_FOUND' });
  });

  it('a cache write failure never fails the lookup', async () => {
    fs.mkdirSync(path.dirname(CACHE_DIR), { recursive: true });
    fs.writeFileSync(CACHE_DIR, 'not a dir'); // mkdir/write under it fails
    postMock.mockResolvedValue({ status: 200, data: { data: [apiGame()] } });
    expect(await getHLTBTimes('Unwritable Game')).toMatchObject({ success: true });
    fs.rmSync(CACHE_DIR, { force: true });
  });

  it('a corrupt cache file is a miss (logged), not a crash', () => {
    writeCache('Corrupt Game', { mainStory: 1, mainExtra: 1, completionist: 1 });
    fs.writeFileSync(getCachePath('Corrupt Game'), '{not json');
    expect(readCache('Corrupt Game')).toBeNull();
  });
});

describe('DUN-132: provider flow through the server axios transport', () => {
  it('discovers, mints a token, and POSTs the search with it (real Hollow Knight shape)', async () => {
    postMock.mockResolvedValue(ok(FLOW.search));
    const result = await getHLTBTimes('Hollow Knight');

    expect(result.success).toBe(true);
    const [hk] = FLOW.search.data;
    expect(hk.game_name).toBe('Hollow Knight');
    expect(result.times).toMatchObject({
      mainStory: secondsToMinutes(hk.comp_main),
      mainExtra: secondsToMinutes(hk.comp_plus),
      completionist: secondsToMinutes(hk.comp_100),
    });
    expect(result.times!.mainStory / 60).toBeCloseTo(27, 0);

    expect(homeCalls()).toHaveLength(1);
    expect(initCalls()).toHaveLength(1);
    expect(String(initCalls()[0][0])).toMatch(new RegExp(`^${HLTB_BASE_URL}/api/search/site/init\\?t=\\d+$`));
    expect(postMock).toHaveBeenCalledTimes(1);
    const [url, body, config] = postMock.mock.calls[0] as [string, Record<string, unknown>, { headers: Record<string, string> }];
    expect(url).toBe(`${HLTB_BASE_URL}/api/search/site`);
    expect(body).toMatchObject({ searchType: 'games', searchTerms: ['Hollow', 'Knight'] });
    expect(config.headers).toMatchObject({ 'x-auth-token': FLOW.init.token, Origin: HLTB_BASE_URL, Referer: `${HLTB_BASE_URL}/` });
    // The token is minted and used with the same User-Agent.
    const initConfig = initCalls()[0][1] as { headers: Record<string, string> };
    expect(config.headers['User-Agent']).toBe(initConfig.headers['User-Agent']);
  });

  it('on 403 refreshes the token once and retries', async () => {
    mockSite([ok({ token: 'expired' }), ok({ token: 'fresh' })]);
    postMock.mockResolvedValueOnce({ status: 403, data: { error: 'IFW-U01' } }).mockResolvedValueOnce(ok(FLOW.search));

    const result = await getHLTBTimes('Hollow Knight');
    expect(result.success).toBe(true);
    expect(postMock).toHaveBeenCalledTimes(2);
    expect(initCalls()).toHaveLength(2);
    expect(homeCalls()).toHaveLength(1); // a 403 is a token problem, not a moved endpoint
    const headers = (n: number) => (postMock.mock.calls[n][2] as { headers: Record<string, string> }).headers['x-auth-token'];
    expect([headers(0), headers(1)]).toEqual(['expired', 'fresh']);
  });

  it('on 404 rediscovers the endpoint once and retries', async () => {
    postMock.mockResolvedValueOnce({ status: 404, data: 'Not Found' }).mockResolvedValueOnce(ok(FLOW.search));
    const result = await getHLTBTimes('Hollow Knight');
    expect(result.success).toBe(true);
    expect(homeCalls()).toHaveLength(2);
    expect(postMock).toHaveBeenCalledTimes(2);
  });

  it('a refresh that still fails is HLTB_UNAVAILABLE after exactly one retry', async () => {
    postMock.mockResolvedValue({ status: 403, data: { error: 'IFW-U01' } });
    const result = await getHLTBTimes('Hollow Knight');
    expect(result).toEqual({ success: false, code: 'HLTB_UNAVAILABLE', message: 'HowLongToBeat is unavailable' });
    expect(postMock).toHaveBeenCalledTimes(2);
    expect(initCalls()).toHaveLength(2);
  });
});
