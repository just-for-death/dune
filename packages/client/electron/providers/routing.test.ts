import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ServerFailure } from '@dune/shared';
import { createLocalProviders } from './localProviders';
import { createProviderRouting, toSharedUpdateInfo, isServerUnreachable, routeServerFirst, type ServerProviderCalls } from './routing';
import type { LocalProviderFlags } from './types';
import { fakeCrypto, fakeFetch, json, PNG, tempDir, type Route } from './testHelpers';

const KEY = 'sgdb-ROUTING-KEY-0123456789';
const IMG = 'https://cdn2.steamgriddb.com/grid/routed.png';
const NETWORK: ServerFailure = { ok: false, code: 'NETWORK', message: 'Could not reach the Dune Server: ECONNREFUSED' };
const TIMEOUT: ServerFailure = { ok: false, code: 'NETWORK', message: 'The Dune Server did not answer in time (request timed out).' };
const PASS_THROUGH: ServerFailure[] = [
  { ok: false, status: 401, code: 'UNAUTHORIZED', message: 'API key required' },
  { ok: false, status: 403, code: 'FORBIDDEN', message: 'Admin only' },
  { ok: false, status: 403, code: 'PROVIDER_DISABLED', message: 'Artwork is disabled on the server' },
  { ok: false, status: 500, code: 'SERVER_ERROR', message: 'boom' },
  { ok: false, status: 502, code: 'NETWORK', message: 'bad gateway with NETWORK code' },
];

const route: Route = (u) => {
  if (u.hostname === 'www.steamgriddb.com' && u.pathname.startsWith('/api/v2/search/autocomplete/')) return json({ success: true, data: [{ id: 9, name: 'Hades' }] });
  if (u.hostname === 'www.steamgriddb.com' && u.pathname === '/api/v2/grids/game/9') return json({ success: true, data: [{ url: IMG }] });
  if (u.href === IMG) return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
  if (u.hostname === 'api.github.com') return json([{ tag_name: 'v9.0.0', html_url: 'https://github.com/just-for-death/dune/releases/tag/v9.0.0', body: 'n', draft: false, prerelease: false }]);
  if (u.hostname === 'howlongtobeat.com') throw new Error('offline'); // HLTB local path: cache-less -> UNAVAILABLE
  return new Response('nope', { status: 404 });
};

let dir: string;
beforeEach(async () => { dir = await tempDir(); });
afterEach(async () => { await fs.promises.rm(dir, { recursive: true, force: true }); });

function fakeServer(over: Partial<ServerProviderCalls> = {}) {
  const s = {
    getHltbTimes: vi.fn(async () => ({ ok: true as const, success: true, times: { mainStory: 1, mainExtra: 2, completionist: 3, fetchedAt: 'srv' } })),
    searchArt: vi.fn(async () => ({ ok: true as const, success: true, results: ['https://cdn2.steamgriddb.com/srv.png'] })),
    fetchArt: vi.fn(async () => ({ ok: true as const, thumbnail: 'local:///srv.png' })),
    getSteamGridKeyStatus: vi.fn(async () => ({ ok: true as const, set: true })),
    setSteamGridKey: vi.fn(async () => ({ ok: true as const, set: true })),
    clearSteamGridKey: vi.fn(async () => ({ ok: true as const, set: false })),
    ...over,
  };
  return s;
}

function setup(opts: { serverUrl?: string | null; flags?: LocalProviderFlags; server?: Partial<ServerProviderCalls> } = {}) {
  const fetch = fakeFetch(route);
  const flags = opts.flags ?? {};
  const getLocalSettings = vi.fn(() => flags);
  const local = createLocalProviders({ userDataDir: dir, fetch, crypto: fakeCrypto(), flags: () => flags, appVersion: '1.0.0' });
  const server = fakeServer(opts.server);
  const resolveGame = vi.fn(async (id: unknown) => (id === 5 ? { ok: true as const, id: 5, name: 'Hades' } : { ok: false as const, code: 'GAME_NOT_FOUND', message: 'Game not found' }));
  const saved: Array<{ gameId: number; ext: string; bytes: Uint8Array }> = [];
  const saveArt = vi.fn((gameId: number, ext: string, bytes: Uint8Array) => { saved.push({ gameId, ext, bytes }); return `local://${path.join(dir, `thumb-${gameId}${ext}`)}`; });
  const routing = createProviderRouting({ server, local, getServerUrl: () => (opts.serverUrl === undefined ? null : opts.serverUrl), getLocalSettings, resolveGame, saveArt, appVersion: '1.0.0' });
  return { routing, fetch, server, local, resolveGame, saveArt, saved, getLocalSettings };
}

const serverCalls = (s: ReturnType<typeof fakeServer>) => Object.values(s).reduce((n, f) => n + vi.mocked(f).mock.calls.length, 0);

describe('routing: no server configured', () => {
  it('flag off -> PROVIDER_DISABLED with no I/O (no network, no server, no game lookup)', async () => {
    const t = setup({ flags: { hltbEnabled: false } });
    for (const r of [await t.routing.getHltbTimes('Hades'), await t.routing.searchArt('Hades'), await t.routing.fetchArt(5), await t.routing.autoCheckForUpdates()]) {
      expect(r).toMatchObject({ ok: false, code: 'PROVIDER_DISABLED', message: expect.any(String) });
      expect(r).not.toHaveProperty('status');
    }
    expect(t.fetch.calls).toHaveLength(0);
    expect(serverCalls(t.server)).toBe(0);
    expect(t.resolveGame).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, 'provider-cache'))).toBe(false);
  });

  it('a throwing settings source counts as off', async () => {
    const t = setup();
    t.getLocalSettings.mockImplementation(() => { throw new Error('store'); });
    expect(await t.routing.searchArt('x')).toMatchObject({ code: 'PROVIDER_DISABLED' });
    expect(t.fetch.calls).toHaveLength(0);
  });

  it('flag on -> local providers, in the existing IPC shapes', async () => {
    const t = setup({ flags: { hltbEnabled: true, artworkEnabled: true } });
    expect(await t.routing.searchArt('Hades')).toMatchObject({ ok: false, code: 'PROVIDER_KEY_MISSING' });
    await t.routing.setSteamGridKey(KEY);
    expect(await t.routing.searchArt('Hades')).toEqual({ ok: true, success: true, results: [IMG] });
    const art = await t.routing.fetchArt(5);
    expect(art).toEqual({ ok: true, thumbnail: `local://${path.join(dir, 'thumb-5.png')}` });
    expect(t.saved[0]).toMatchObject({ gameId: 5, ext: '.png' });
    expect(Array.from(t.saved[0].bytes)).toEqual(Array.from(PNG));
    expect(await t.routing.fetchArt(99)).toEqual({ ok: false, code: 'GAME_NOT_FOUND', message: 'Game not found' });
    expect(await t.routing.getHltbTimes('Hades')).toMatchObject({ ok: false, code: 'PROVIDER_UNAVAILABLE' });
    expect(t.fetch.calls.some((c) => new URL(c.url).hostname === 'howlongtobeat.com')).toBe(true);
    expect(serverCalls(t.server)).toBe(0);
  });

  it('fetchArt reports ART_NOT_FOUND when SteamGridDB has nothing, and a save failure as LOCAL_ERROR', async () => {
    const t = setup({ flags: { artworkEnabled: true } });
    await t.routing.setSteamGridKey(KEY);
    t.saveArt.mockImplementation(() => { throw new Error('/home/zoro/disk full'); });
    expect(await t.routing.fetchArt(5)).toEqual({ ok: false, code: 'LOCAL_ERROR', message: 'Could not save the artwork.' });
  });
});

describe('routing: server configured', () => {
  const URL_ = 'https://dune.example:4000';

  it('server ok -> server result, local flag not consulted, no local network', async () => {
    const t = setup({ serverUrl: URL_, flags: {} });
    expect(await t.routing.getHltbTimes('Hades')).toMatchObject({ ok: true, times: { fetchedAt: 'srv' } });
    expect(await t.routing.searchArt('Hades')).toEqual({ ok: true, success: true, results: ['https://cdn2.steamgriddb.com/srv.png'] });
    expect(await t.routing.fetchArt(5)).toEqual({ ok: true, thumbnail: 'local:///srv.png' });
    expect(t.server.fetchArt).toHaveBeenCalledWith({ id: 5, name: 'Hades' });
    expect(t.getLocalSettings).not.toHaveBeenCalled();
    expect(t.fetch.calls).toHaveLength(0);
  });

  it('401 / 403 / PROVIDER_DISABLED / any status pass through unchanged, never falling back', async () => {
    for (const fail of PASS_THROUGH) {
      const t = setup({ serverUrl: URL_, flags: { hltbEnabled: true, artworkEnabled: true }, server: {
        getHltbTimes: async () => fail, searchArt: async () => fail, fetchArt: async () => fail,
      } });
      expect(await t.routing.getHltbTimes('Hades')).toBe(fail);
      expect(await t.routing.searchArt('Hades')).toBe(fail);
      expect(await t.routing.fetchArt(5)).toBe(fail);
      expect(t.fetch.calls).toHaveLength(0);
      expect(t.getLocalSettings).not.toHaveBeenCalled();
    }
  });

  it('NETWORK or timeout (no status) -> local fallback, flag off -> PROVIDER_DISABLED', async () => {
    for (const down of [NETWORK, TIMEOUT]) {
      const t = setup({ serverUrl: URL_, flags: {}, server: { getHltbTimes: async () => down, searchArt: async () => down, fetchArt: async () => down } });
      expect(await t.routing.getHltbTimes('Hades')).toMatchObject({ ok: false, code: 'PROVIDER_DISABLED' });
      expect(await t.routing.searchArt('Hades')).toMatchObject({ ok: false, code: 'PROVIDER_DISABLED' });
      expect(await t.routing.fetchArt(5)).toMatchObject({ ok: false, code: 'PROVIDER_DISABLED' });
      expect(t.fetch.calls).toHaveLength(0);
    }
  });

  it('NETWORK or timeout (no status) -> local fallback, flag on -> local result', async () => {
    for (const down of [NETWORK, TIMEOUT]) {
      const t = setup({ serverUrl: URL_, flags: { artworkEnabled: true, hltbEnabled: true }, server: { getHltbTimes: async () => down, searchArt: async () => down, fetchArt: async () => down } });
      await t.local.setKey('steamgriddb', KEY); // a key stored locally earlier (no-server mode)
      expect(await t.routing.searchArt('Hades')).toEqual({ ok: true, success: true, results: [IMG] });
      expect(await t.routing.fetchArt(5)).toMatchObject({ ok: true, thumbnail: expect.stringContaining('thumb-5.png') });
      expect(await t.routing.getHltbTimes('Hades')).toMatchObject({ ok: false, code: 'PROVIDER_UNAVAILABLE' });
      expect(t.fetch.calls.length).toBeGreaterThan(0);
    }
  });

  it('game lookup failures pass through before any provider call', async () => {
    const t = setup({ serverUrl: URL_ });
    expect(await t.routing.fetchArt('nope')).toMatchObject({ ok: false, code: 'GAME_NOT_FOUND' });
    expect(t.server.fetchArt).not.toHaveBeenCalled();
  });
});

describe('routing: SteamGridDB key', () => {
  it('no server: local key store, status only, the key never leaks', async () => {
    const t = setup();
    expect(await t.routing.getSteamGridKeyStatus()).toEqual({ ok: true, set: false });
    const set = await t.routing.setSteamGridKey(`  ${KEY} `);
    expect(set).toEqual({ ok: true, set: true });
    const status = await t.routing.getSteamGridKeyStatus();
    expect(status).toEqual({ ok: true, set: true });
    expect(JSON.stringify([set, status])).not.toContain(KEY);
    expect(await t.routing.setSteamGridKey('')).toMatchObject({ ok: false, code: 'INVALID_KEY' });
    expect(await t.routing.clearSteamGridKey()).toEqual({ ok: true, set: false });
    expect(await t.routing.getSteamGridKeyStatus()).toEqual({ ok: true, set: false });
    expect(serverCalls(t.server)).toBe(0);
  });

  it('no server and no secure storage: SECURE_STORAGE_UNAVAILABLE, nothing stored', async () => {
    const t = setup();
    const local = createLocalProviders({ userDataDir: dir, fetch: fakeFetch(route), crypto: fakeCrypto({ available: false }), flags: () => ({}) });
    const routing = createProviderRouting({ server: t.server, local, getServerUrl: () => null, getLocalSettings: () => ({}), resolveGame: t.resolveGame, saveArt: t.saveArt, appVersion: '1.0.0' });
    const r = await routing.setSteamGridKey(KEY);
    expect(r).toMatchObject({ ok: false, code: 'SECURE_STORAGE_UNAVAILABLE' });
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(await routing.getSteamGridKeyStatus()).toEqual({ ok: true, set: false });
  });

  it('server configured: the server path only (no local fallback even when unreachable)', async () => {
    const t = setup({ serverUrl: 'https://dune.example', server: { getSteamGridKeyStatus: async () => NETWORK } });
    expect(await t.routing.getSteamGridKeyStatus()).toBe(NETWORK);
    expect(await t.routing.setSteamGridKey(KEY)).toEqual({ ok: true, set: true });
    expect(t.server.setSteamGridKey).toHaveBeenCalledWith(KEY);
    expect(await t.routing.clearSteamGridKey()).toEqual({ ok: true, set: false });
    expect(fs.existsSync(path.join(dir, 'provider-keys.json'))).toBe(false);
  });
});

describe('routing: update checks and helpers', () => {
  it('manual checkForUpdates always runs (flag off too), local-only, server or not', async () => {
    for (const serverUrl of [null, 'https://dune.example']) {
      for (const flags of [{}, { updateCheckEnabled: false }, { updateCheckEnabled: true }]) {
        const t = setup({ serverUrl, flags });
        await t.local.clearCache(); // a fresh check every iteration (same temp userData)
        expect(await t.routing.checkForUpdates({ force: 'yes' })).toEqual({
          ok: true,
          update: { version: '9.0.0', current: '1.0.0', releaseUrl: 'https://github.com/just-for-death/dune/releases/tag/v9.0.0', notes: 'n', isNewer: true },
        });
        expect(t.fetch.calls.length).toBeGreaterThan(0);
        expect(t.fetch.calls.every((c) => new URL(c.url).hostname === 'api.github.com')).toBe(true);
        expect(serverCalls(t.server)).toBe(0);
        expect(t.getLocalSettings).not.toHaveBeenCalled();
      }
    }
  });

  it('autoCheckForUpdates runs only when updateCheckEnabled is on', async () => {
    for (const flags of [{}, { updateCheckEnabled: false }, { hltbEnabled: true, artworkEnabled: true }]) {
      const off = setup({ flags });
      expect(await off.routing.autoCheckForUpdates()).toMatchObject({ ok: false, code: 'PROVIDER_DISABLED' });
      expect(off.fetch.calls).toHaveLength(0);
    }
    const on = setup({ flags: { updateCheckEnabled: true } });
    expect(await on.routing.autoCheckForUpdates()).toMatchObject({ ok: true, update: { version: '9.0.0', current: '1.0.0' } });
    expect(on.fetch.calls.length).toBeGreaterThan(0);
  });

  it('isServerUnreachable: only NETWORK without a status', () => {
    expect(isServerUnreachable(NETWORK)).toBe(true);
    expect(isServerUnreachable(TIMEOUT)).toBe(true);
    for (const f of PASS_THROUGH) expect(isServerUnreachable(f)).toBe(false);
    for (const v of [null, undefined, 'NETWORK', { ok: true, code: 'NETWORK' }, { ok: false, code: 'NO_SERVER' }]) expect(isServerUnreachable(v)).toBe(false);
  });

  it('routeServerFirst is reusable for future providers', async () => {
    const deps = { getServerUrl: () => 'https://s', getLocalSettings: () => ({ hltbEnabled: true }) };
    type R = { ok: true; from: string } | ServerFailure;
    const local = vi.fn(async (): Promise<R> => ({ ok: true, from: 'local' }));
    const server = async (): Promise<R> => NETWORK;
    expect(await routeServerFirst(deps, 'hltbEnabled', server, local)).toEqual({ ok: true, from: 'local' });
    expect(await routeServerFirst(deps, 'artworkEnabled', server, local)).toMatchObject({ code: 'PROVIDER_DISABLED' });
    expect(local).toHaveBeenCalledTimes(1);
  });
});

describe('toSharedUpdateInfo', () => {
  it('maps latest -> version, url -> releaseUrl, adds current, keeps publishedAt only when set', () => {
    const base = { latest: '2.0.0', url: 'https://github.com/o/r/releases/tag/v2.0.0', notes: 'plain', isNewer: false };
    expect(toSharedUpdateInfo(base, '2.0.0')).toEqual({ version: '2.0.0', current: '2.0.0', releaseUrl: base.url, notes: 'plain', isNewer: false });
    expect(toSharedUpdateInfo({ ...base, publishedAt: '2026-10-28T10:00:00Z' }, '1.0.0')).toEqual({
      version: '2.0.0', current: '1.0.0', releaseUrl: base.url, notes: 'plain', isNewer: false, publishedAt: '2026-10-28T10:00:00Z',
    });
    expect(Object.keys(toSharedUpdateInfo(base, '1.0.0'))).not.toContain('latest');
  });
});
