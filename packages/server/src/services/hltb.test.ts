import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('axios');
import axios from 'axios';
import { getHLTBTimes, bulkFetchHLTB, readCache, writeCache } from './hltb.js';

const HLTB_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-hltb-test-'));
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
  delete process.env.DATA_DIR;
  fs.rmSync(HLTB_TMP, { recursive: true, force: true });
});

function apiGame(overrides = {}) {
  return { comp_main: 20, comp_plus: 30, comp_100: 50, ...overrides };
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
    const cachePath = path.join(CACHE_DIR, 'test-game-ttl.json');
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

  it('should fetch, convert hours to minutes, and cache on miss', async () => {
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
    const cachePath = path.join(CACHE_DIR, 'stale-fallback-game.json');
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
