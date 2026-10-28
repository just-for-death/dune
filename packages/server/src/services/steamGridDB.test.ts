import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('axios');
import axios from 'axios';
import { database } from '../db/index.js';
import { ApiError } from '../utils/apiError.js';
import { searchGame, getGridImages, searchArt, autoMatchAll, artworkEnabled, requireArtworkEnabled } from './steamGridDB.js';

const getMock = vi.mocked(axios.get);
const ok = (data: unknown) => ({ status: 200, headers: {}, data });
const IMG1 = 'https://cdn2.steamgriddb.com/grid/1.jpg';
const IMG2 = 'https://cdn2.steamgriddb.com/grid/2.png';
const setArtwork = (on: unknown) => database.saveSettings({ ...database.getSettings(), artworkEnabled: on as boolean });

beforeEach(() => {
  setArtwork(true);
  getMock.mockReset();
  getMock.mockRejectedValue(new Error('offline'));
});

describe('Settings.artworkEnabled opt-in (FEAT-providers-2a)', () => {
  it('defaults to off; only exactly true enables', () => {
    database.saveSettings({ ...database.getSettings(), artworkEnabled: undefined as unknown as boolean });
    expect(database.getSettings().artworkEnabled).toBe(false);
    for (const v of [false, 'true', 1]) {
      setArtwork(v);
      expect(artworkEnabled()).toBe(false);
      expect(() => requireArtworkEnabled()).toThrow(ApiError);
    }
    setArtwork(true);
    expect(artworkEnabled()).toBe(true);
    expect(() => requireArtworkEnabled()).not.toThrow();
  });

  it('disabled: zero requests; adapter calls answer 403 PROVIDER_DISABLED', async () => {
    setArtwork(false);
    await expect(searchArt('key', 'G')).rejects.toMatchObject({ status: 403, code: 'PROVIDER_DISABLED' });
    await expect(searchGame('key', 'G')).rejects.toMatchObject({ code: 'PROVIDER_DISABLED' });
    await expect(getGridImages('key', 7)).rejects.toMatchObject({ code: 'PROVIDER_DISABLED' });
    await expect(autoMatchAll('key', [{ name: 'A', thumbnail: '' }])).rejects.toMatchObject({ code: 'PROVIDER_DISABLED' });
    expect(getMock).not.toHaveBeenCalled();
  });
});

describe('searchGame', () => {
  it('returns the first match, with the key as a Bearer header', async () => {
    getMock.mockResolvedValue(ok({ success: true, data: [{ id: 7, name: 'G' }] }));
    await expect(searchGame('key', 'G')).resolves.toEqual({ id: 7, name: 'G' });
    expect(getMock.mock.calls[0]![0]).toBe('https://www.steamgriddb.com/api/v2/search/autocomplete/G');
    expect(getMock.mock.calls[0]![1]).toMatchObject({ headers: { Authorization: 'Bearer key' }, timeout: 10000, maxRedirects: 0 });
  });

  it('returns null on empty results and on network failure', async () => {
    getMock.mockResolvedValue(ok({ success: true, data: [] }));
    await expect(searchGame('key', 'Nope')).resolves.toBeNull();
    getMock.mockRejectedValue(new Error('offline'));
    await expect(searchGame('key', 'Nope')).resolves.toBeNull();
  });
});

describe('getGridImages', () => {
  it('maps CDN grid urls, drops off-CDN ones, and returns [] when empty or failing', async () => {
    getMock.mockResolvedValue(ok({ success: true, data: [{ url: IMG1 }, { url: 'http://a/2.jpg' }, { url: IMG2 }] }));
    await expect(getGridImages('key', 7)).resolves.toEqual([IMG1, IMG2]);
    expect(String(getMock.mock.calls[0]![0])).toBe('https://www.steamgriddb.com/api/v2/grids/game/7?dimensions=600x900,460x215,920x430');
    getMock.mockResolvedValue(ok({ success: true, data: [] }));
    await expect(getGridImages('key', 7)).resolves.toEqual([]);
    getMock.mockRejectedValue(new Error('offline'));
    await expect(getGridImages('key', 7)).resolves.toEqual([]);
  });
});

describe('searchArt', () => {
  it('returns [] when the game is unknown or the lookup fails (route shape unchanged)', async () => {
    getMock.mockResolvedValue(ok({ success: true, data: [] }));
    await expect(searchArt('key', 'Unknown')).resolves.toEqual({ success: true, results: [] });
    getMock.mockResolvedValue({ status: 503, headers: {}, data: {} });
    await expect(searchArt('key', 'Unknown')).resolves.toEqual({ success: true, results: [] });
  });

  it('returns the grids of the first match', async () => {
    getMock.mockImplementation(async (url: string) =>
      String(url).includes('autocomplete') ? ok({ success: true, data: [{ id: 1, name: 'A' }] }) : ok({ success: true, data: [{ url: IMG1 }] }));
    await expect(searchArt('key', 'A')).resolves.toEqual({ success: true, results: [IMG1] });
  });
});

describe('autoMatchAll', () => {
  it('returns matches and skips games that already have thumbnails', async () => {
    getMock.mockImplementation(async (url: string) => {
      if (String(url).includes('autocomplete')) return ok({ success: true, data: [{ id: 1, name: 'A' }] });
      return ok({ success: true, data: [{ url: IMG1 }] });
    });
    const matched = await autoMatchAll('key', [
      { name: 'A', thumbnail: '' },
      { name: 'B', thumbnail: 'http://already/has.jpg' },
    ]);
    expect(matched).toEqual([{ name: 'A', thumbnail: IMG1 }]);
    // One search + one grids call for A only
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it('per-game failures are skipped; a rejected key stops the run with []', async () => {
    getMock.mockRejectedValue(new Error('offline'));
    await expect(autoMatchAll('key', [{ name: 'A', thumbnail: '' }])).resolves.toEqual([]);
    getMock.mockReset();
    getMock.mockResolvedValue({ status: 401, headers: {}, data: { success: false } });
    await expect(autoMatchAll('key', [{ name: 'A', thumbnail: '' }, { name: 'B', thumbnail: '' }])).resolves.toEqual([]);
    expect(getMock).toHaveBeenCalledTimes(1);
  });
});
