import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hltbCacheKey } from '@dune/providers';
import { createLocalProviders } from './localProviders';
import { createDiskCache } from './diskCache';
import { CACHE_DIR_NAME } from './diskCache';
import { KEY_FILE_NAME } from './keyStore';
import type { LocalProviderFlags } from './types';
import { fakeCrypto, fakeFetch, json, PNG, type Route } from './testHelpers';
import { tempDir } from './testHelpers';

const KEY = 'sgdb-LIVE-KEY-abcdef0123456789';
const IMG = 'https://cdn2.steamgriddb.com/grid/abc.png';
const ALL_ON: LocalProviderFlags = { hltbEnabled: true, artworkEnabled: true, updateCheckEnabled: true };
const RELEASES = [
  { tag_name: 'v0.3.0', html_url: 'https://github.com/just-for-death/dune/releases/tag/v0.3.0', body: 'Fixes\r\n<b>x</b>', draft: false, prerelease: false, published_at: '2026-10-27T10:00:00Z' },
  { tag_name: 'v0.1.0', html_url: 'https://github.com/just-for-death/dune/releases/tag/v0.1.0', body: 'old', draft: false, prerelease: false },
];

const sgdbRoute: Route = (u) => {
  if (u.hostname === 'www.steamgriddb.com' && u.pathname.startsWith('/api/v2/search/autocomplete/')) return json({ success: true, data: [{ id: 7, name: 'Hades' }] });
  if (u.hostname === 'www.steamgriddb.com' && u.pathname === '/api/v2/grids/game/7') return json({ success: true, data: [{ url: IMG }, { url: 'https://evil.example/x.png' }] });
  if (u.href === IMG) return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) } });
  if (u.hostname === 'api.github.com') return json(RELEASES);
  return new Response('not found', { status: 404 });
};

let dir: string;
let t: number;
beforeEach(async () => { dir = await tempDir(); t = 1_800_000_000_000; });
afterEach(async () => { await fs.promises.rm(dir, { recursive: true, force: true }); });

function setup(flags: LocalProviderFlags | (() => LocalProviderFlags) = ALL_ON, route: Route = sgdbRoute, appVersion = '0.2.0') {
  const fetch = fakeFetch(route);
  const crypto = fakeCrypto();
  const lp = createLocalProviders({ userDataDir: dir, fetch, crypto, flags: typeof flags === 'function' ? flags : () => flags, appVersion, now: () => t });
  return { lp, fetch, crypto };
}

describe('createLocalProviders: gating', () => {
  it('everything is off by default: PROVIDER_DISABLED, zero network, zero key reads, nothing on disk', async () => {
    // Non-boolean values a corrupt settings store could hold: only `true` enables.
    const junk: Record<string, unknown> = { hltbEnabled: 'yes', artworkEnabled: 1, updateCheckEnabled: 'true' };
    for (const flags of [{}, junk as LocalProviderFlags, () => { throw new Error('settings'); }]) {
      const { lp, fetch, crypto } = setup(flags);
      await lp.setKey('steamgriddb', KEY);
      crypto.decrypts = 0;
      const results = [await lp.getHltbTimes('Hades'), await lp.searchArt('Hades'), await lp.downloadArt(IMG), await lp.checkForUpdates()];
      for (const r of results) expect(r).toMatchObject({ ok: false, code: 'PROVIDER_DISABLED' });
      expect(fetch.calls).toHaveLength(0);
      expect(crypto.decrypts).toBe(0);
      expect(fs.existsSync(path.join(dir, CACHE_DIR_NAME))).toBe(false);
    }
  });

  it('reads flags on every call (toggle without rebuilding)', async () => {
    let flags: LocalProviderFlags = {};
    const { lp, fetch } = setup(() => flags);
    await lp.setKey('steamgriddb', KEY);
    expect(await lp.searchArt('Hades')).toMatchObject({ code: 'PROVIDER_DISABLED' });
    flags = { artworkEnabled: true };
    expect(await lp.searchArt('Hades')).toEqual({ ok: true, results: [IMG] });
    expect(fetch.calls.length).toBeGreaterThan(0);
    expect(await lp.getHltbTimes('Hades')).toMatchObject({ code: 'PROVIDER_DISABLED' });
  });
});

describe('createLocalProviders: SteamGridDB', () => {
  it('needs a key: PROVIDER_KEY_MISSING without one, no request', async () => {
    const { lp, fetch } = setup();
    expect(await lp.searchArt('Hades')).toMatchObject({ ok: false, code: 'PROVIDER_KEY_MISSING' });
    expect(fetch.calls).toHaveLength(0);
  });

  it('sends the key only as a Bearer header to the API host and never returns it', async () => {
    const { lp, fetch } = setup();
    expect(await lp.setKey('steamgriddb', KEY)).toEqual({ ok: true, set: true });
    expect(await lp.getKeyStatus('steamgriddb')).toEqual({ ok: true, set: true });
    const res = await lp.searchArt('Hades');
    expect(res).toEqual({ ok: true, results: [IMG] }); // off-CDN URL dropped
    expect(JSON.stringify(res)).not.toContain(KEY);
    for (const c of fetch.calls) {
      expect(new URL(c.url).hostname).toBe('www.steamgriddb.com');
      expect(c.url).not.toContain(KEY);
      expect(c.headers.Authorization).toBe(`Bearer ${KEY}`);
    }
    expect(await fs.promises.readFile(path.join(dir, KEY_FILE_NAME), 'utf8')).not.toContain(KEY);
  });

  it('maps provider failures to { ok: false, code, message } without the key', async () => {
    const { lp } = setup(ALL_ON, () => json({ success: false }, 401));
    await lp.setKey('steamgriddb', KEY);
    const r = await lp.searchArt('Hades');
    expect(r).toMatchObject({ ok: false, code: 'PROVIDER_KEY_MISSING', message: expect.any(String) });
    expect(JSON.stringify(r)).not.toContain(KEY);
    const r2 = await setup(ALL_ON, () => { throw new Error(`down ${KEY}`); }).lp.searchArt('x');
    expect(r2).toMatchObject({ ok: false });
  });

  it('downloads CDN images once and serves them from the disk cache', async () => {
    const { lp, fetch } = setup();
    const first = await lp.downloadArt(IMG);
    expect(first).toMatchObject({ ok: true, contentType: 'image/png', cached: false });
    expect(fetch.calls.map((c) => c.url)).toEqual([IMG]);
    expect(fetch.calls[0].headers.Authorization).toBeUndefined();
    const second = await lp.downloadArt(IMG);
    expect(second).toMatchObject({ ok: true, contentType: 'image/png', cached: true });
    expect(second.ok && Array.from(second.bytes)).toEqual(Array.from(PNG));
    expect(fetch.calls).toHaveLength(1);
  });

  it('blocks non-CDN, http and odd image URLs before any request', async () => {
    const { lp, fetch } = setup();
    for (const u of ['https://evil.example/x.png', 'http://cdn2.steamgriddb.com/a.png', 'https://user:pw@cdn2.steamgriddb.com/a.png', 'file:///etc/passwd', 42]) {
      expect(await lp.downloadArt(u)).toMatchObject({ ok: false, code: 'PROVIDER_HOST_BLOCKED' });
    }
    expect(fetch.calls).toHaveLength(0);
  });

  it('rejects non-images (svg/html) from the CDN', async () => {
    const { lp } = setup(ALL_ON, () => new Response('<svg/>', { status: 200, headers: { 'content-type': 'image/svg+xml' } }));
    expect(await lp.downloadArt(IMG)).toMatchObject({ ok: false, code: 'PROVIDER_BAD_CONTENT_TYPE' });
  });
});

describe('createLocalProviders: HLTB', () => {
  const seed = async (value: unknown, storedAt: number) => {
    const c = createDiskCache({ userDataDir: dir, namespace: 'hltb', ttlMs: 1e12, maxBytes: 1e7, now: () => storedAt });
    await c.setJson(hltbCacheKey('Hades'), value);
  };

  it('serves a fresh disk-cache hit with no network', async () => {
    await seed({ mainStory: 1320, mainExtra: 1800, completionist: 3700, fetchedAt: '2026-10-01T00:00:00.000Z' }, t - 1000);
    const { lp, fetch } = setup();
    expect(await lp.getHltbTimes('  Hades ')).toEqual({ ok: true, times: { mainStory: 1320, mainExtra: 1800, completionist: 3700, fetchedAt: '2026-10-01T00:00:00.000Z' } });
    expect(fetch.calls).toHaveLength(0);
  });

  it('falls back to a stale entry when HLTB is unreachable', async () => {
    await seed({ mainStory: 60, mainExtra: 0, completionist: 0 }, t - 40 * 24 * 3600_000);
    const { lp, fetch } = setup(ALL_ON, () => { throw new Error('offline'); });
    const r = await lp.getHltbTimes('Hades');
    expect(r).toMatchObject({ ok: true, stale: true, times: { mainStory: 60, fetchedAt: expect.any(String) } });
    expect(fetch.calls.length).toBeGreaterThan(0);
    expect(fetch.calls.every((c) => new URL(c.url).hostname === 'howlongtobeat.com')).toBe(true);
  });

  it('reports PROVIDER_UNAVAILABLE with no cache, and INVALID_INPUT for bad titles', async () => {
    const { lp } = setup(ALL_ON, () => { throw new Error('offline'); });
    expect(await lp.getHltbTimes('Hades')).toMatchObject({ ok: false, code: 'PROVIDER_UNAVAILABLE' });
    for (const bad of ['', '   ', 'x'.repeat(201), null, {}]) expect(await lp.getHltbTimes(bad)).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });
});

describe('createLocalProviders: update checks', () => {
  it('checks GitHub releases (api.github.com only) and caches on disk', async () => {
    const { lp, fetch } = setup();
    const r = await lp.checkForUpdates();
    expect(r).toMatchObject({ ok: true, update: { latest: '0.3.0', isNewer: true, url: 'https://github.com/just-for-death/dune/releases/tag/v0.3.0' } });
    expect(r.ok && r.update.notes).toBe('Fixes\n<b>x</b>');
    expect(fetch.calls.every((c) => new URL(c.url).hostname === 'api.github.com')).toBe(true);
    const n = fetch.calls.length;
    const lp2 = setup().lp; // a fresh instance (app restart) reads the disk cache
    expect(await lp2.checkForUpdates()).toMatchObject({ ok: true, update: { latest: '0.3.0' } });
    expect(await lp.checkForUpdates()).toMatchObject({ ok: true });
    expect(fetch.calls.length).toBe(n);
  });

  it('is not newer when the app is current; stale cache on failure; bad version -> INVALID_INPUT', async () => {
    expect(await setup(ALL_ON, sgdbRoute, '0.3.0').lp.checkForUpdates()).toMatchObject({ ok: true, update: { isNewer: false } });
    t += 7 * 3600_000; // past the 6 h provider TTL, inside disk retention
    const off = setup(ALL_ON, () => { throw new Error('offline'); }, '0.2.0');
    expect(await off.lp.checkForUpdates()).toMatchObject({ ok: true, stale: true, update: { latest: '0.3.0', isNewer: true } });
    expect(await setup(ALL_ON, sgdbRoute, 'not-semver').lp.checkForUpdates()).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });

  it('a manual check always runs (the click is the opt-in); auto stays gated and is the default', async () => {
    const { lp, fetch } = setup({});
    expect(await lp.checkForUpdates()).toMatchObject({ ok: false, code: 'PROVIDER_DISABLED' });
    expect(await lp.checkForUpdates({ trigger: 'auto', force: true })).toMatchObject({ ok: false, code: 'PROVIDER_DISABLED' });
    expect(fetch.calls).toHaveLength(0);
    expect(await lp.checkForUpdates({ trigger: 'manual' })).toMatchObject({ ok: true, update: { latest: '0.3.0', isNewer: true } });
    expect(fetch.calls.length).toBeGreaterThan(0);
    expect(fetch.calls.every((c) => new URL(c.url).hostname === 'api.github.com')).toBe(true);
    // Manual and auto share the disk cache: with the flag on, auto is served from it.
    const n = fetch.calls.length;
    const auto = setup({ updateCheckEnabled: true });
    expect(await auto.lp.checkForUpdates({ trigger: 'auto' })).toMatchObject({ ok: true, update: { latest: '0.3.0' } });
    expect(auto.fetch.calls).toHaveLength(0);
    expect(fetch.calls).toHaveLength(n);
    // Other provider flags never stand in for the update flag.
    expect(await setup({ hltbEnabled: true, artworkEnabled: true }).lp.checkForUpdates({ trigger: 'auto' })).toMatchObject({ code: 'PROVIDER_DISABLED' });
  });
});

describe('createLocalProviders: cache + static checks', () => {
  it('clearCache drops cached images but keeps keys', async () => {
    const { lp, fetch } = setup();
    await lp.setKey('steamgriddb', KEY);
    await lp.downloadArt(IMG);
    expect(await lp.clearCache()).toEqual({ ok: true, cleared: true });
    await lp.downloadArt(IMG);
    expect(fetch.calls.filter((c) => c.url === IMG)).toHaveLength(2);
    expect(await lp.getKeyStatus('steamgriddb')).toEqual({ ok: true, set: true });
  });

  it('only electron.ts imports electron; nothing here logs to the console', async () => {
    const here = path.dirname(new URL(import.meta.url).pathname);
    const files = (await fs.promises.readdir(here)).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    for (const f of files) {
      const src = await fs.promises.readFile(path.join(here, f), 'utf8');
      const importsElectron = /from\s+['"]electron['"]|require\(\s*['"]electron['"]\s*\)/.test(src);
      expect(importsElectron, f).toBe(f === 'electron.ts');
      expect(/console\.(log|info|warn|error|debug)/.test(src), f).toBe(false);
    }
  });
});
