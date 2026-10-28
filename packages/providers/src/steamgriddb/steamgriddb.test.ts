import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import { ProviderError } from '../core/errors.js';
import type { HttpRequest, HttpResponse, HttpTransport, ProviderLogger } from '../core/types.js';
import { createSteamGridDbProvider, isAllowedImageUrl, STEAMGRIDDB_GRID_DIMENSIONS, type SteamGridDbProviderOptions } from './provider.js';

const FX = JSON.parse(fs.readFileSync(new URL('./steamgriddb.fixture.json', import.meta.url), 'utf-8')) as {
  autocomplete: unknown; autocompleteEmpty: unknown; grids: { data: Array<{ url: string }> }; unauthorized: unknown;
};
const KEY = 'sgdbTESTKEY0123456789abcdef';
const ok = (data: unknown, headers: Record<string, string> = {}): HttpResponse => ({ status: 200, headers, data });
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

type Route = (req: HttpRequest) => HttpResponse | Promise<HttpResponse>;
function setup(route: Route, o: Partial<SteamGridDbProviderOptions> = {}) {
  const calls: HttpRequest[] = [];
  const transport: HttpTransport = vi.fn(async (req: HttpRequest) => { calls.push(req); return route(req); });
  const warn = vi.fn();
  const logger: ProviderLogger = { info: vi.fn(), warn };
  const provider = createSteamGridDbProvider({ transport, enabled: () => true, key: () => KEY, logger, ...o });
  return { provider, calls, transport, warn };
}
const api: Route = (req) => {
  const u = new URL(req.url);
  if (u.pathname.startsWith('/api/v2/search/autocomplete/')) return ok(decodeURIComponent(u.pathname).endsWith('/Hades') ? FX.autocomplete : FX.autocompleteEmpty);
  if (u.pathname.startsWith('/api/v2/grids/game/')) return ok(FX.grids);
  return { status: 404, headers: {}, data: {} };
};

describe('SteamGridDB provider: gating and key', () => {
  it('disabled (false, non-boolean truthy, throwing) -> PROVIDER_DISABLED with zero requests and no key read', async () => {
    for (const enabled of [() => false, () => 'true' as unknown as boolean, () => { throw new Error('x'); }]) {
      const key = vi.fn(() => KEY);
      const { provider, transport } = setup(api, { enabled, key });
      for (const r of [await provider.searchArt('Hades'), await provider.searchGame('Hades'), await provider.getGrids(1), await provider.autoMatch([{ name: 'A', thumbnail: '' }]), await provider.downloadImage(FX.grids.data[0]!.url)]) {
        expect(r).toMatchObject({ ok: false, code: 'PROVIDER_DISABLED' });
      }
      expect(transport).not.toHaveBeenCalled();
      expect(key).not.toHaveBeenCalled();
    }
  });

  it('missing key -> PROVIDER_KEY_MISSING with zero requests', async () => {
    for (const key of [() => null, () => '', () => { throw new Error('vault'); }]) {
      const { provider, transport } = setup(api, { key });
      expect(await provider.searchArt('Hades')).toMatchObject({ ok: false, code: 'PROVIDER_KEY_MISSING' });
      expect(transport).not.toHaveBeenCalled();
    }
  });

  it('sends the key only as a Bearer header to www.steamgriddb.com, never in the URL', async () => {
    const { provider, calls } = setup(api);
    await provider.searchArt('Hades');
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(new URL(c.url).hostname).toBe('www.steamgriddb.com');
      expect(c.headers).toEqual({ Authorization: `Bearer ${KEY}` });
      expect(c.url).not.toContain(KEY);
    }
  });
});

describe('SteamGridDB provider: lookups (fixture)', () => {
  it('searchGame returns the first autocomplete match; null when none', async () => {
    const { provider, calls } = setup(api);
    expect(await provider.searchGame('Hades')).toEqual({ ok: true, value: { id: 5248055, name: 'Hades' } });
    expect(calls[0]!.url).toBe('https://www.steamgriddb.com/api/v2/search/autocomplete/Hades');
    expect(await provider.searchGame('Nothing Here')).toEqual({ ok: true, value: null });
    expect(calls[1]!.url).toBe('https://www.steamgriddb.com/api/v2/search/autocomplete/Nothing%20Here');
  });

  it('searchArt -> CDN grid urls in order; [] for an unknown game (no grids call)', async () => {
    const { provider, calls } = setup(api);
    expect(await provider.searchArt('Hades')).toEqual({ ok: true, value: FX.grids.data.map((g) => g.url) });
    expect(calls[1]!.url).toBe(`https://www.steamgriddb.com/api/v2/grids/game/5248055?dimensions=${STEAMGRIDDB_GRID_DIMENSIONS}`);
    calls.length = 0;
    expect(await provider.searchArt('Unknown')).toEqual({ ok: true, value: [] });
    expect(calls).toHaveLength(1);
  });

  it('drops grid urls that are not https on the CDN allow-list', async () => {
    const { provider, warn } = setup(() => ok({ success: true, data: [{ url: 'https://evil.example/x.png' }, { url: 'http://cdn2.steamgriddb.com/a.png' }, { url: 42 }, null, { url: 'https://cdn2.steamgriddb.com/grid/ok.png' }] }));
    expect(await provider.getGrids(7)).toEqual({ ok: true, value: ['https://cdn2.steamgriddb.com/grid/ok.png'] });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ dropped: 4 }), expect.any(String));
  });

  it('rejects bad game ids and bad shapes; maps HTTP statuses', async () => {
    const { provider, transport } = setup(api);
    expect(await provider.getGrids(0)).toMatchObject({ ok: false, code: 'PROVIDER_NOT_FOUND' });
    expect(await provider.getGrids(1.5)).toMatchObject({ ok: false, code: 'PROVIDER_NOT_FOUND' });
    expect(transport).not.toHaveBeenCalled();
    const cases: Array<[HttpResponse, string]> = [
      [{ status: 401, headers: {}, data: FX.unauthorized }, 'PROVIDER_KEY_MISSING'],
      [{ status: 429, headers: {}, data: {} }, 'PROVIDER_RATE_LIMITED'],
      [{ status: 503, headers: {}, data: {} }, 'PROVIDER_UNAVAILABLE'],
      [ok({ success: false }), 'PROVIDER_BAD_RESPONSE'],
      [ok('<html>'), 'PROVIDER_BAD_RESPONSE'],
      [ok({ success: true, data: [{ id: '1', name: 'x' }] }), 'PROVIDER_BAD_RESPONSE'],
    ];
    for (const [res, code] of cases) {
      const s = setup(() => res);
      expect(await s.provider.searchGame('x')).toMatchObject({ ok: false, code });
    }
    expect(await setup(() => ok({ success: true })).provider.searchGame('x')).toEqual({ ok: true, value: null });
  });

  it('transport failure -> typed failure with the key redacted', async () => {
    const { provider, warn } = setup(() => { throw new Error(`socket hang up for Bearer ${KEY}`); });
    const r = await provider.searchArt('Hades');
    expect(r).toMatchObject({ ok: false, code: 'PROVIDER_UNAVAILABLE' });
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);
    const t = setup(() => { throw new ProviderError('PROVIDER_TIMEOUT', 'timed out'); });
    expect(await t.provider.searchGame('x')).toMatchObject({ ok: false, code: 'PROVIDER_TIMEOUT' });
  });

  it('redirects off the API host are blocked', async () => {
    const { provider, calls } = setup(() => ({ status: 302, headers: { location: 'https://evil.example/steal' }, data: '' }));
    expect(await provider.searchGame('x')).toMatchObject({ ok: false, code: 'PROVIDER_HOST_BLOCKED' });
    expect(calls).toHaveLength(1);
  });
});

describe('SteamGridDB provider: autoMatch', () => {
  it('matches games without thumbnails, skips the rest, pauses between games', async () => {
    const sleep = vi.fn(async () => {});
    const { provider, calls } = setup(api);
    const r = await provider.autoMatch([
      { name: 'Hades', thumbnail: '' },
      { name: 'Has', thumbnail: 'https://cdn2.steamgriddb.com/grid/x.png' },
      { name: 'Unknown', thumbnail: '' },
    ], { sleep });
    expect(r).toEqual({ ok: true, value: { matched: [{ name: 'Hades', thumbnail: FX.grids.data[0]!.url }], errors: [] } });
    expect(calls).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(300);
  });

  it('collects per-game failures and continues; stops on a rejected key', async () => {
    let n = 0;
    const flaky = setup((req) => { if (n++ === 0) throw new Error('reset'); return api(req); });
    const r = await flaky.provider.autoMatch([{ name: 'A', thumbnail: '' }, { name: 'Hades', thumbnail: '' }], { delayMs: 0 });
    expect(r).toMatchObject({ ok: true, value: { matched: [{ name: 'Hades' }], errors: [{ game: 'A', code: 'PROVIDER_UNAVAILABLE' }] } });
    const bad = setup(() => ({ status: 401, headers: {}, data: FX.unauthorized }));
    expect(await bad.provider.autoMatch([{ name: 'A', thumbnail: '' }, { name: 'B', thumbnail: '' }], { delayMs: 0 })).toMatchObject({ ok: false, code: 'PROVIDER_KEY_MISSING' });
    expect(bad.calls).toHaveLength(1);
    const fail = setup(() => ok({ success: false }));
    expect(await fail.provider.autoMatch([{ name: 'A', thumbnail: '' }], { delayMs: 0 })).toMatchObject({ ok: true, value: { errors: [{ code: 'PROVIDER_BAD_RESPONSE' }] } });
  });

  it('uses a real timer by default', async () => {
    vi.useFakeTimers();
    try {
      const { provider } = setup(api);
      const p = provider.autoMatch([{ name: 'X', thumbnail: '' }, { name: 'Y', thumbnail: '' }]);
      await vi.advanceTimersByTimeAsync(300);
      expect(await p).toMatchObject({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SteamGridDB provider: image download (DUN-027)', () => {
  it('downloads a png from the CDN without the key', async () => {
    const { provider, calls } = setup(() => ok(PNG, { 'content-type': 'image/png', 'content-length': String(PNG.length) }));
    const r = await provider.downloadImage(FX.grids.data[0]!.url);
    expect(r).toEqual({ ok: true, value: { bytes: PNG, contentType: 'image/png' } });
    expect(calls[0]).toMatchObject({ responseType: 'bytes', maxBytes: 10 * 1024 * 1024 });
    expect(calls[0]!.headers).toBeUndefined();
  });

  it('refuses non-CDN, http and credentialed URLs before any request', async () => {
    const { provider, transport } = setup(() => ok(PNG, { 'content-type': 'image/png' }));
    for (const url of ['https://evil.example/a.png', 'http://cdn2.steamgriddb.com/a.png', 'https://u:p@cdn2.steamgriddb.com/a.png', 'https://cdn2.steamgriddb.com:8443/a.png', 'https://www.steamgriddb.com/api/v2/grids/game/1', 'not a url']) {
      expect(await provider.downloadImage(url)).toMatchObject({ ok: false, code: 'PROVIDER_HOST_BLOCKED' });
    }
    expect(transport).not.toHaveBeenCalled();
    expect(isAllowedImageUrl(7)).toBe(false);
  });

  it('a CDN redirect to another host is blocked', async () => {
    const { provider, calls } = setup(() => ({ status: 302, headers: { location: 'https://evil.example/a.png' }, data: new Uint8Array() }));
    expect(await provider.downloadImage('https://cdn2.steamgriddb.com/grid/a.png')).toMatchObject({ ok: false, code: 'PROVIDER_HOST_BLOCKED' });
    expect(calls).toHaveLength(1);
  });

  it('rejects svg/html, mismatched bytes and oversize images', async () => {
    const url = 'https://cdn2.steamgriddb.com/grid/a.png';
    const svg = setup(() => ok(new TextEncoder().encode('<svg/>'), { 'content-type': 'image/svg+xml' }));
    expect(await svg.provider.downloadImage(url)).toMatchObject({ ok: false, code: 'PROVIDER_BAD_CONTENT_TYPE' });
    const lie = setup(() => ok(new TextEncoder().encode('<html>'), { 'content-type': 'image/png' }));
    expect(await lie.provider.downloadImage(url)).toMatchObject({ ok: false, code: 'PROVIDER_BAD_CONTENT_TYPE' });
    const big = setup(() => ok(PNG, { 'content-type': 'image/png' }), { imageMaxBytes: 4 });
    expect(await big.provider.downloadImage(url)).toMatchObject({ ok: false, code: 'PROVIDER_TOO_LARGE' });
    expect(big.calls[0]!.maxBytes).toBe(4);
  });
});
