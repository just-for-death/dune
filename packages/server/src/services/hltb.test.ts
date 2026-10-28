import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('axios');
import axios from 'axios';
import { getHLTBTimes, bulkFetchHLTB, readCache, writeCache, getCachePath, normalizeTitle, secondsToMinutes } from './hltb.js';

/**
 * DUN-043: real HowLongToBeat record for Hollow Knight (comp_* in SECONDS),
 * trimmed to the relevant fields; the site shows 27 h / 41½ h / 65½ h.
 */
const FIXTURE = JSON.parse(fs.readFileSync(new URL('./hltb.fixture.json', import.meta.url), 'utf-8')) as {
  websiteHours: Record<string, string>;
  data: Array<{ game_name: string; comp_main: number; comp_plus: number; comp_100: number }>;
};

const HLTB_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-hltb-test-'));
const SETUP_DATA_DIR = process.env.DATA_DIR as string; // temp dir from src/test/setup.ts (DUN-005)
process.env.DATA_DIR = HLTB_TMP;
const postMock = vi.mocked(axios.post);
const CACHE_DIR = path.join(process.env.DATA_DIR as string, 'hltb-cache');

beforeEach(() => {
  postMock.mockReset();
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

  it('should expire cache after TTL', () => {
    const times = { mainStory: 600, mainExtra: 900, completionist: 1200 };
    writeCache('Test Game TTL', times);

    // Manually modify the cache file to be old
    const cachePath = getCachePath('Test Game TTL');
    const oldTime = Date.now() - 31 * 24 * 60 * 60 * 1000; // 31 days ago
    fs.utimesSync(cachePath, new Date(oldTime), new Date(oldTime));

    const cached = readCache('Test Game TTL');
    expect(cached).toBeNull();
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
    postMock.mockResolvedValue({ data: { data: [apiGame()] } });

    const result = await getHLTBTimes('Some Game');
    expect(result.success).toBe(true);
    expect(result.times).toMatchObject({ mainStory: 1200, mainExtra: 1800, completionist: 3000 });
    // Second call served from cache — still exactly one HTTP request
    await getHLTBTimes('Some Game');
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it('should return not found when API has no match', async () => {
    postMock.mockResolvedValue({ data: { data: [] } });

    const result = await getHLTBTimes('This Game Does Not Exist 12345');
    expect(result.success).toBe(false);
  });

  it('should return not found when the network fails', async () => {
    postMock.mockRejectedValue(new Error('network down'));

    const result = await getHLTBTimes('Any Game');
    expect(result.success).toBe(false);
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

describe('bulkFetchHLTB', () => {
  it('should return cached times and skip HTTP for cached games', async () => {
    writeCache('Game A', { mainStory: 600, mainExtra: 900, completionist: 1200 });
    writeCache('Game B', { mainStory: 1200, mainExtra: 1800, completionist: 2400 });
    postMock.mockResolvedValue({ data: { data: [] } });

    const results = await bulkFetchHLTB(['Game A', 'Game B', 'Game C']);

    expect(results.size).toBe(2);
    expect(results.get('Game A')).toEqual({ mainStory: 600, mainExtra: 900, completionist: 1200 });
    expect(results.get('Game B')).toEqual({ mainStory: 1200, mainExtra: 1800, completionist: 2400 });
    expect(results.has('Game C')).toBe(false);
    // Only the uncached name triggers a request
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it('should handle empty array without network', async () => {
    const results = await bulkFetchHLTB([]);
    expect(results.size).toBe(0);
    expect(postMock).not.toHaveBeenCalled();
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

    postMock.mockResolvedValue({ data: { data: FIXTURE.data } });
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
    expect(normalizeTitle('  Hollow   KNIGHT ')).toBe('hollow knight');
    expect(getCachePath('Hollow Knight')).toBe(getCachePath(' hollow  knight'));
    expect(getCachePath('ＡＢＣ')).toBe(getCachePath('abc'));
  });

  it('surfaces HLTB_UNAVAILABLE on network errors and HLTB_NOT_FOUND on no match', async () => {
    postMock.mockRejectedValue(new Error('network down'));
    expect(await getHLTBTimes('Net Fail Game')).toMatchObject({ success: false, code: 'HLTB_UNAVAILABLE' });
    postMock.mockResolvedValue({ data: { unexpected: true } });
    expect(await getHLTBTimes('Bad Shape Game')).toMatchObject({ success: false, code: 'HLTB_UNAVAILABLE' });
    postMock.mockResolvedValue({ data: { data: [] } });
    expect(await getHLTBTimes('No Match Game')).toMatchObject({ success: false, code: 'HLTB_NOT_FOUND' });
  });

  it('a corrupt cache file is a miss (logged), not a crash', () => {
    writeCache('Corrupt Game', { mainStory: 1, mainExtra: 1, completionist: 1 });
    fs.writeFileSync(getCachePath('Corrupt Game'), '{not json');
    expect(readCache('Corrupt Game')).toBeNull();
  });
});
