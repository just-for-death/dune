import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('axios');
import axios from 'axios';
import { searchGame, getGridImages, searchArt, autoMatchAll } from './steamGridDB.js';

const getMock = vi.mocked(axios.get);

beforeEach(() => {
  getMock.mockReset();
  getMock.mockRejectedValue(new Error('offline'));
});

describe('searchGame', () => {
  it('returns the first match', async () => {
    getMock.mockResolvedValue({ data: { success: true, data: [{ id: 7, name: 'G' }] } });
    await expect(searchGame('key', 'G')).resolves.toEqual({ id: 7, name: 'G' });
  });

  it('returns null on empty results and on network failure', async () => {
    getMock.mockResolvedValue({ data: { success: true, data: [] } });
    await expect(searchGame('key', 'Nope')).resolves.toBeNull();
    getMock.mockRejectedValue(new Error('offline'));
    await expect(searchGame('key', 'Nope')).resolves.toBeNull();
  });
});

describe('getGridImages', () => {
  it('maps grid urls and returns [] when empty or failing', async () => {
    getMock.mockResolvedValue({ data: { success: true, data: [{ url: 'http://a/1.jpg' }, { url: 'http://a/2.jpg' }] } });
    await expect(getGridImages('key', 7)).resolves.toEqual(['http://a/1.jpg', 'http://a/2.jpg']);
    getMock.mockResolvedValue({ data: { success: true, data: [] } });
    await expect(getGridImages('key', 7)).resolves.toEqual([]);
  });
});

describe('searchArt', () => {
  it('returns [] when the game is unknown', async () => {
    getMock.mockResolvedValue({ data: { success: true, data: [] } });
    await expect(searchArt('key', 'Unknown')).resolves.toEqual({ success: true, results: [] });
  });
});

describe('autoMatchAll', () => {
  it('returns matches and skips games that already have thumbnails', async () => {
    getMock.mockImplementation(async (url: string) => {
      if (String(url).includes('autocomplete')) return { data: { success: true, data: [{ id: 1, name: 'A' }] } };
      return { data: { success: true, data: [{ url: 'http://img/a.jpg' }] } };
    });
    const matched = await autoMatchAll('key', [
      { name: 'A', thumbnail: '' },
      { name: 'B', thumbnail: 'http://already/has.jpg' },
    ]);
    expect(matched).toEqual([{ name: 'A', thumbnail: 'http://img/a.jpg' }]);
    // One search + one grids call for A only
    expect(getMock).toHaveBeenCalledTimes(2);
  });
});
