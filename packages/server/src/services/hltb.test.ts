import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getHLTBTimes, bulkFetchHLTB, readCache, writeCache } from './hltb.js';

const CACHE_DIR = path.join(process.cwd(), 'data', 'hltb-cache');

beforeEach(() => {
  if (fs.existsSync(CACHE_DIR)) fs.rmSync(CACHE_DIR, { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  if (fs.existsSync(CACHE_DIR)) fs.rmSync(CACHE_DIR, { recursive: true });
});

describe('Cache functions', () => {
  it('should write and read cache', () => {
    const times = { mainStory: 1200, mainExtra: 1800, completionist: 3000 };
    writeCache('Test Game', times);
    
    const cached = readCache('Test Game');
    expect(cached).toEqual(times);
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
    const oldTime = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago
    fs.utimesSync(cachePath, new Date(oldTime), new Date(oldTime));
    
    const cached = readCache('Test Game TTL');
    expect(cached).toBeNull();
  });
});

describe('getHLTBTimes', () => {
  it('should return cached times when available', async () => {
    const times = { mainStory: 1200, mainExtra: 1800, completionist: 3000 };
    writeCache('Cached Game', times);
    
    const result = await getHLTBTimes('Cached Game');
    expect(result.success).toBe(true);
    expect(result.times).toEqual(times);
  });

  it('should return not found for unknown game (no network call in test)', async () => {
    const result = await getHLTBTimes('This Game Does Not Exist 12345');
    expect(result.success).toBe(false);
  });
});

describe('bulkFetchHLTB', () => {
  it('should return cached times for multiple games', async () => {
    writeCache('Game A', { mainStory: 600, mainExtra: 900, completionist: 1200 });
    writeCache('Game B', { mainStory: 1200, mainExtra: 1800, completionist: 2400 });
    
    const results = await bulkFetchHLTB(['Game A', 'Game B', 'Game C']);
    
    expect(results.size).toBe(2);
    expect(results.get('Game A')).toEqual({ mainStory: 600, mainExtra: 900, completionist: 1200 });
    expect(results.get('Game B')).toEqual({ mainStory: 1200, mainExtra: 1800, completionist: 2400 });
    expect(results.has('Game C')).toBe(false);
  });

  it('should handle empty array', async () => {
    const results = await bulkFetchHLTB([]);
    expect(results.size).toBe(0);
  });
});
