import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('axios');
import axios from 'axios';
import { LUDUSAVI_MANIFEST_URL, MANIFEST_ATTRIBUTION, MANIFEST_CACHE_TTL_MS, type CacheEntry, type CachedManifest } from '@dune/providers';

// Own temp DATA_DIR (never packages/server/data): the file cache lives under it.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-manifest-provider-test-'));
const SETUP_DATA_DIR = process.env.DATA_DIR as string;
process.env.DATA_DIR = TMP;

const { database } = await import('../db/index.js');
const {
  createServerManifestProvider, lookupManifest, manifestCacheDir, manifestEnabled, manifestFileCache, manifestQueryForGame, requireManifestEnabled,
} = await import('./manifestProvider.js');
const { isApiError } = await import('../utils/apiError.js');

const getMock = vi.mocked(axios.get);
const setEnabled = (on: unknown) => database.saveSettings({ ...database.getSettings(), manifestEnabled: on as boolean });
const CACHE_FILE = () => path.join(manifestCacheDir(), 'ludusavi-manifest.json');
const DAY = 24 * 60 * 60 * 1000;

const YAML = [
  '---',
  'Hollow Knight:',
  '  files:',
  '    "<winLocalAppDataLow>/Team Cherry/Hollow Knight/*.dat":',
  '      tags: [save]',
  '      when: [{ os: windows }]',
  '    "<home>/.config/unity3d/Team Cherry/Hollow Knight/*.dat":',
  '      tags: [save]',
  '  launch:',
  '    "<base>/hollow_knight.exe": [{ arguments: "--evil" }]',
  '  steam:',
  '    id: 367520',
  '  gog:',
  '    id: 1308320804',
  'Celeste:',
  '  gog:',
  '    id: 1955430409',
  '  files:',
  '    "<home>/.local/share/Celeste/Saves":',
  '',
].join('\n');

const ok = (data = YAML, headers: Record<string, string> = { 'content-type': 'text/plain; charset=utf-8', etag: '"v1"' }) =>
  ({ status: 200, headers, data }) as never;

async function apiError(p: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await p;
  } catch (e) {
    if (isApiError(e)) return { status: e.status, code: e.code };
    throw e;
  }
  throw new Error('expected an ApiError');
}

beforeEach(() => {
  getMock.mockReset();
  getMock.mockRejectedValue(new Error('offline'));
  fs.rmSync(manifestCacheDir(), { recursive: true, force: true });
  setEnabled(true);
});

afterAll(() => {
  process.env.DATA_DIR = SETUP_DATA_DIR;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('Settings.manifestEnabled opt-in', () => {
  it('defaults to false and only === true enables', () => {
    database.saveSettings({ ...database.getSettings(), manifestEnabled: undefined as unknown as boolean });
    expect(database.getSettings().manifestEnabled).toBe(false);
    for (const v of [false, 'true', 1, null]) {
      setEnabled(v);
      expect(manifestEnabled()).toBe(false);
      expect(() => requireManifestEnabled()).toThrow(expect.objectContaining({ status: 403, code: 'PROVIDER_DISABLED' }));
    }
    setEnabled(true);
    expect(manifestEnabled()).toBe(true);
    expect(() => requireManifestEnabled()).not.toThrow();
  });

  it('disabled: 403 PROVIDER_DISABLED with no request and no cache read', async () => {
    setEnabled(false);
    const getSpy = vi.spyOn(manifestFileCache, 'get');
    expect(await apiError(lookupManifest({ title: 'Hollow Knight' }, createServerManifestProvider()))).toEqual({ status: 403, code: 'PROVIDER_DISABLED' });
    expect(getMock).not.toHaveBeenCalled();
    expect(getSpy).not.toHaveBeenCalled();
    getSpy.mockRestore();
  });
});

describe('lookupManifest', () => {
  it('downloads through the axios transport (>= 60 s timeout, any status accepted) and caches under DATA_DIR', async () => {
    getMock.mockResolvedValueOnce(ok());
    const provider = createServerManifestProvider();
    const hit = await lookupManifest({ title: 'hollow  KNIGHT' }, provider);
    expect(getMock).toHaveBeenCalledTimes(1);
    const [url, config] = getMock.mock.calls[0]!;
    expect(url).toBe(LUDUSAVI_MANIFEST_URL);
    expect(config!.timeout).toBeGreaterThanOrEqual(60_000);
    expect(config!.maxRedirects).toBe(0);
    for (const status of [200, 304, 404, 500]) expect(config!.validateStatus!(status)).toBe(true);
    expect(hit.stale).toBe(false);
    expect(hit.pageUrl).toBe('https://www.pcgamingwiki.com/wiki/Hollow_Knight');
    expect(hit.attribution).toEqual(MANIFEST_ATTRIBUTION);
    expect(hit.entry.title).toBe('Hollow Knight');
    // Paths are returned verbatim (placeholders unexpanded); launch entries never leave the provider.
    expect(Object.keys(hit.entry.files ?? {})).toEqual([
      '<winLocalAppDataLow>/Team Cherry/Hollow Knight/*.dat',
      '<home>/.config/unity3d/Team Cherry/Hollow Knight/*.dat',
    ]);
    expect(hit.entry).not.toHaveProperty('launch');
    // File cache is in the temp DATA_DIR, never packages/server/data.
    expect(CACHE_FILE().startsWith(TMP)).toBe(true);
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE(), 'utf-8')) as CachedManifest;
    expect(cached.etag).toBe('"v1"');
    expect(Object.keys(cached.games).sort()).toEqual(['Celeste', 'Hollow Knight']);
  });

  it('keeps the last good copy in memory: later lookups (Steam id, GOG id) make no request', async () => {
    getMock.mockResolvedValueOnce(ok());
    const provider = createServerManifestProvider();
    expect((await lookupManifest({ steamId: 367520 }, provider)).entry.title).toBe('Hollow Knight');
    expect((await lookupManifest({ gogId: 1955430409 }, provider)).entry.title).toBe('Celeste');
    // Steam id wins over GOG id, which wins over the title.
    expect((await lookupManifest({ steamId: 367520, gogId: 1955430409, title: 'Celeste' }, provider)).entry.title).toBe('Hollow Knight');
    expect((await lookupManifest({ gogId: 1955430409, title: 'Hollow Knight' }, provider)).entry.title).toBe('Celeste');
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('a fresh process reads the file cache instead of downloading', async () => {
    getMock.mockResolvedValueOnce(ok());
    await lookupManifest({ title: 'Celeste' }, createServerManifestProvider());
    const again = await lookupManifest({ title: 'Celeste' }, createServerManifestProvider());
    expect(again.stale).toBe(false);
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('revalidates an expired cache with If-None-Match and accepts 304 without throwing', async () => {
    getMock.mockResolvedValueOnce(ok());
    await lookupManifest({ title: 'Celeste' }, createServerManifestProvider());
    getMock.mockResolvedValueOnce({ status: 304, headers: {}, data: '' } as never);
    const later = createServerManifestProvider(() => Date.now() + MANIFEST_CACHE_TTL_MS + DAY);
    const hit = await lookupManifest({ title: 'Celeste' }, later);
    expect(hit.stale).toBe(false);
    expect(getMock).toHaveBeenCalledTimes(2);
    expect((getMock.mock.calls[1]![1]!.headers as Record<string, string>)['If-None-Match']).toBe('"v1"');
  });

  it('serves the cached copy marked stale when a refresh fails', async () => {
    getMock.mockResolvedValueOnce(ok());
    await lookupManifest({ title: 'Celeste' }, createServerManifestProvider());
    const later = createServerManifestProvider(() => Date.now() + MANIFEST_CACHE_TTL_MS + DAY);
    getMock.mockRejectedValueOnce(new Error('offline'));
    expect((await lookupManifest({ title: 'Celeste' }, later)).stale).toBe(true);
    getMock.mockResolvedValueOnce({ status: 500, headers: {}, data: '' } as never);
    expect((await lookupManifest({ title: 'Celeste' }, createServerManifestProvider(() => Date.now() + MANIFEST_CACHE_TTL_MS + DAY))).stale).toBe(true);
  });

  it('404 MANIFEST_NOT_FOUND for a game that is not in the manifest', async () => {
    getMock.mockResolvedValueOnce(ok());
    expect(await apiError(lookupManifest({ title: 'Not A Real Game' }, createServerManifestProvider()))).toEqual({ status: 404, code: 'MANIFEST_NOT_FOUND' });
  });

  it('503 MANIFEST_UNAVAILABLE with no cached copy (network error, bad status, bad content type)', async () => {
    expect(await apiError(lookupManifest({ title: 'Celeste' }, createServerManifestProvider()))).toEqual({ status: 503, code: 'MANIFEST_UNAVAILABLE' });
    getMock.mockResolvedValueOnce({ status: 503, headers: {}, data: '' } as never);
    expect(await apiError(lookupManifest({ title: 'Celeste' }, createServerManifestProvider()))).toEqual({ status: 503, code: 'MANIFEST_UNAVAILABLE' });
    getMock.mockResolvedValueOnce(ok('<html></html>', { 'content-type': 'text/html' }));
    expect(await apiError(lookupManifest({ title: 'Celeste' }, createServerManifestProvider()))).toEqual({ status: 503, code: 'MANIFEST_UNAVAILABLE' });
  });

  it('flag turned off after creation is still honoured per call', async () => {
    getMock.mockResolvedValueOnce(ok());
    const provider = createServerManifestProvider();
    await lookupManifest({ title: 'Celeste' }, provider);
    setEnabled(false);
    expect(await apiError(lookupManifest({ title: 'Celeste' }, provider))).toEqual({ status: 403, code: 'PROVIDER_DISABLED' });
  });

  it('uses the module-level provider by default', async () => {
    getMock.mockResolvedValueOnce(ok());
    expect((await lookupManifest({ title: 'Celeste' })).entry.title).toBe('Celeste');
  });
});

describe('manifestFileCache', () => {
  it('missing, corrupt or wrongly shaped files are misses', () => {
    expect(manifestFileCache.get('ludusavi-manifest')).toBeNull();
    fs.mkdirSync(manifestCacheDir(), { recursive: true });
    fs.writeFileSync(CACHE_FILE(), '{not json');
    expect(manifestFileCache.get('ludusavi-manifest')).toBeNull();
    fs.writeFileSync(CACHE_FILE(), JSON.stringify({ games: [], fetchedAt: 1, skipped: 0 }));
    expect(manifestFileCache.get('ludusavi-manifest')).toBeNull();
    fs.writeFileSync(CACHE_FILE(), JSON.stringify({ games: {}, fetchedAt: 1, skipped: 0, etag: 5 }));
    expect(manifestFileCache.get('ludusavi-manifest')).toBeNull();
  });

  it('round-trips a value with the file mtime as storedAt, atomically', () => {
    const value: CachedManifest = { games: {}, skipped: 0, fetchedAt: 123 };
    manifestFileCache.set('ludusavi-manifest', value);
    const entry = manifestFileCache.get('ludusavi-manifest') as CacheEntry<CachedManifest>;
    expect(entry.value).toEqual(value);
    expect(entry.storedAt).toBe(fs.statSync(CACHE_FILE()).mtimeMs);
    expect(fs.readdirSync(manifestCacheDir())).toEqual(['ludusavi-manifest.json']);
  });

  it('refuses keys that are not plain names (no path built), and never throws', () => {
    for (const key of ['../escape', 'a/b', '', 'UPPER']) {
      expect(manifestFileCache.get(key)).toBeNull();
      expect(() => manifestFileCache.set(key, { games: {}, skipped: 0, fetchedAt: 1 })).not.toThrow();
    }
    expect(fs.existsSync(path.join(TMP, 'escape.json'))).toBe(false);
    expect(fs.existsSync(manifestCacheDir())).toBe(false);
  });
});

describe('FEAT-server-storeIds: lookup by a game row (Steam id, then GOG id, then title)', () => {
  const row = (name: string, steamAppId: string | null = null, gogId: string | null = null) => ({ name, steamAppId, gogId });

  it('builds the query from the row: numeric ids, title always kept as the last resort', () => {
    expect(manifestQueryForGame(row('Hollow Knight', '367520', '1308320804'))).toEqual({ title: 'Hollow Knight', steamId: 367520, gogId: 1308320804 });
    expect(manifestQueryForGame(row('Celeste', null, '1955430409'))).toEqual({ title: 'Celeste', gogId: 1955430409 });
    expect(manifestQueryForGame({ name: 'No Ids' })).toEqual({ title: 'No Ids' });
    // A stored value that is not a canonical digit string is ignored, never guessed.
    for (const bad of ['', '0', '0367520', '12a', '1234567890123', ' 367520']) {
      expect(manifestQueryForGame(row('X', bad, bad))).toEqual({ title: 'X' });
    }
  });

  it('Steam id path: a renamed game is found by its Steam app id', async () => {
    getMock.mockResolvedValueOnce(ok());
    const hit = await lookupManifest(manifestQueryForGame(row('HK (my rename)', '367520')), createServerManifestProvider());
    expect(hit.entry.title).toBe('Hollow Knight');
  });

  it('Steam id wins over GOG id and title', async () => {
    getMock.mockResolvedValueOnce(ok());
    const hit = await lookupManifest(manifestQueryForGame(row('Celeste', '367520', '1955430409')), createServerManifestProvider());
    expect(hit.entry.title).toBe('Hollow Knight');
  });

  it('GOG id path: no Steam id, or a Steam id missing from the manifest, falls through to the GOG id', async () => {
    getMock.mockResolvedValueOnce(ok());
    const provider = createServerManifestProvider();
    expect((await lookupManifest(manifestQueryForGame(row('Celeste (GOG)', null, '1955430409')), provider)).entry.title).toBe('Celeste');
    expect((await lookupManifest(manifestQueryForGame(row('Hollow Knight', '999999', '1955430409')), provider)).entry.title).toBe('Celeste');
  });

  it('title path: unknown ids (or none) fall back to the title; nothing matches -> 404 MANIFEST_NOT_FOUND', async () => {
    getMock.mockResolvedValueOnce(ok());
    const provider = createServerManifestProvider();
    expect((await lookupManifest(manifestQueryForGame(row('hollow knight')), provider)).entry.title).toBe('Hollow Knight');
    expect((await lookupManifest(manifestQueryForGame(row('Celeste', '999999', '888888')), provider)).entry.title).toBe('Celeste');
    expect(await apiError(lookupManifest(manifestQueryForGame(row('Unlisted', '999999', '888888')), provider))).toEqual({ status: 404, code: 'MANIFEST_NOT_FOUND' });
    expect(getMock).toHaveBeenCalledTimes(1);
  });
});
