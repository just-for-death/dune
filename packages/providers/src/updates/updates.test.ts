import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import { memoryCache } from '../core/cache.js';
import { ProviderError } from '../core/errors.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../core/types.js';
import { createUpdateCheckProvider, DUNE_GITHUB_REPO, UPDATE_CACHE_TTL_MS, type CachedRelease, type UpdateCheckProviderOptions } from './provider.js';
import { compareSemver, parseSemver } from './semver.js';

const FX = JSON.parse(fs.readFileSync(new URL('./updates.fixture.json', import.meta.url), 'utf-8')) as { releases: unknown[] };
const ok = (data: unknown, headers: Record<string, string> = {}): HttpResponse => ({ status: 200, headers, data });

function setup(o: Partial<UpdateCheckProviderOptions> & { reply?: (req: HttpRequest) => HttpResponse } = {}) {
  const calls: HttpRequest[] = [];
  const reply = o.reply ?? (() => ok(FX.releases));
  const transport: HttpTransport = vi.fn(async (req: HttpRequest) => { calls.push(req); return reply(req); });
  let t = 1_000_000;
  const now = () => t;
  const cache = o.cache ?? memoryCache<CachedRelease>(now);
  const provider = createUpdateCheckProvider({ transport, enabled: () => true, currentVersion: '0.2.0', now, cache, ...o });
  return { provider, calls, transport, cache, advance: (ms: number) => { t += ms; } };
}

describe('semver', () => {
  it('parses strict SemVer with optional v and orders by precedence', () => {
    expect(parseSemver('v1.2.3-beta.2+build.5')).toMatchObject({ major: 1, minor: 2, patch: 3, prerelease: ['beta', 2] });
    for (const bad of ['1.2', '01.2.3', '1.2.3-', 'nightly', '', 7, 'x'.repeat(200), `${'9'.repeat(20)}.0.0`]) expect(parseSemver(bad)).toBeNull();
    const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0'];
    for (let i = 1; i < order.length; i++) {
      expect(compareSemver(parseSemver(order[i - 1])!, parseSemver(order[i])!)).toBe(-1);
      expect(compareSemver(parseSemver(order[i])!, parseSemver(order[i - 1])!)).toBe(1);
    }
    expect(compareSemver(parseSemver('1.0.0+a')!, parseSemver('v1.0.0+b')!)).toBe(0);
    expect(compareSemver(parseSemver('1.0.0-a.1')!, parseSemver('1.0.0-a.1')!)).toBe(0);
  });
});

describe('update check: config and gating', () => {
  it('defaults to the Dune repo; rejects bad repo or version at construction', () => {
    expect(DUNE_GITHUB_REPO).toEqual({ owner: 'just-for-death', repo: 'dune' });
    const base = { transport: vi.fn(), enabled: () => true };
    expect(() => createUpdateCheckProvider({ ...base, currentVersion: 'dev' })).toThrow(TypeError);
    for (const repo of [{ owner: 'a/b', repo: 'x' }, { owner: 'a', repo: '..' }, { owner: '', repo: 'x' }, { owner: 'a', repo: 'x?y' }]) {
      expect(() => createUpdateCheckProvider({ ...base, currentVersion: '1.0.0', repo })).toThrow(TypeError);
    }
  });

  it('disabled -> PROVIDER_DISABLED with zero requests and no cache read', async () => {
    for (const enabled of [() => false, () => 1 as unknown as boolean, () => { throw new Error('x'); }]) {
      const get = vi.fn(() => null);
      const s = setup({ enabled, cache: { get, set: vi.fn() } });
      expect(await s.provider.check()).toMatchObject({ ok: false, code: 'PROVIDER_DISABLED' });
      expect(s.transport).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    }
  });
});

describe('update check: releases (fixture)', () => {
  it('stable user: newest non-draft, non-prerelease SemVer release; GitHub API only, no token', async () => {
    const { provider, calls } = setup();
    expect(await provider.check()).toEqual({ ok: true, value: {
      latest: '0.2.1', url: 'https://github.com/just-for-death/dune/releases/tag/v0.2.1',
      notes: '## Fixes\n- sync <script>alert(1)</script>', isNewer: true, publishedAt: '2026-10-20T10:00:00Z',
    } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.github.com/repos/just-for-death/dune/releases?per_page=30');
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.responseType).toBe('json');
    expect(Object.keys(calls[0]!.headers ?? {}).map((h) => h.toLowerCase())).not.toContain('authorization');
  });

  it('prerelease user (0.2.0-beta.2) also sees betas; isNewer false when up to date', async () => {
    expect(await setup({ currentVersion: '0.2.0-beta.2' }).provider.check()).toMatchObject({ ok: true, value: { latest: '0.3.0-beta.1', isNewer: true } });
    expect(await setup({ currentVersion: '0.3.0-beta.1' }).provider.check()).toMatchObject({ ok: true, value: { latest: '0.3.0-beta.1', isNewer: false } });
    expect(await setup({ currentVersion: '0.2.1' }).provider.check()).toMatchObject({ ok: true, value: { latest: '0.2.1', isNewer: false } });
    expect(await setup({ currentVersion: '1.0.0' }).provider.check()).toMatchObject({ ok: true, value: { isNewer: false } });
    expect(await setup({ includePrereleases: false, currentVersion: '0.2.0-beta.2' }).provider.check()).toMatchObject({ ok: true, value: { latest: '0.2.1' } });
  });

  it('a release url off the repo is replaced by the canonical tag page; notes are capped', async () => {
    const only = [{ tag_name: 'v9.0.0', draft: false, prerelease: false, html_url: 'https://evil.example/phish', body: 'x'.repeat(30_000) }];
    const r = await setup({ reply: () => ok(only) }).provider.check();
    expect(r).toMatchObject({ ok: true, value: { latest: '9.0.0', url: 'https://github.com/just-for-death/dune/releases/tag/v9.0.0' } });
    expect(r.ok && r.value.notes.length).toBe(20_001);
    expect(r.ok && 'publishedAt' in r.value).toBe(false);
    const odd = [{ tag_name: '1.0.0', html_url: 'not a url', body: 5 }, null, 'x'];
    expect(await setup({ reply: () => ok(odd) }).provider.check()).toMatchObject({ ok: true, value: { url: 'https://github.com/just-for-death/dune/releases/tag/1.0.0', notes: '' } });
  });

  it('maps failures: none found, 404, rate limit, forbidden, bad body, transport', async () => {
    const cases: Array<[HttpResponse, string]> = [
      [ok([{ tag_name: 'nightly' }, { tag_name: 'v1.0.0', draft: true }]), 'PROVIDER_NOT_FOUND'],
      [{ status: 404, headers: {}, data: {} }, 'PROVIDER_NOT_FOUND'],
      [{ status: 403, headers: { 'x-ratelimit-remaining': '0' }, data: {} }, 'PROVIDER_RATE_LIMITED'],
      [{ status: 429, headers: {}, data: {} }, 'PROVIDER_RATE_LIMITED'],
      [{ status: 403, headers: {}, data: {} }, 'PROVIDER_UNAVAILABLE'],
      [ok({ message: 'x' }), 'PROVIDER_BAD_RESPONSE'],
    ];
    for (const [res, code] of cases) expect(await setup({ reply: () => res }).provider.check()).toMatchObject({ ok: false, code });
    const t = setup({ reply: () => { throw new ProviderError('PROVIDER_TIMEOUT', 'slow'); } });
    expect(await t.provider.check()).toMatchObject({ ok: false, code: 'PROVIDER_TIMEOUT' });
  });

  it('redirects off api.github.com are blocked (nothing downloaded)', async () => {
    const s = setup({ reply: () => ({ status: 302, headers: { location: 'https://objects.githubusercontent.com/x.AppImage' }, data: '' }) });
    expect(await s.provider.check()).toMatchObject({ ok: false, code: 'PROVIDER_HOST_BLOCKED' });
    expect(s.calls).toHaveLength(1);
  });
});

describe('update check: cache', () => {
  it('serves from cache within the TTL, refetches after it or on force', async () => {
    const s = setup();
    await s.provider.check();
    s.advance(UPDATE_CACHE_TTL_MS - 1);
    expect(await s.provider.check()).toMatchObject({ ok: true, value: { latest: '0.2.1' } });
    expect(s.calls).toHaveLength(1);
    await s.provider.check({ force: true });
    expect(s.calls).toHaveLength(2);
    s.advance(UPDATE_CACHE_TTL_MS);
    await s.provider.check();
    expect(s.calls).toHaveLength(3);
  });

  it('isNewer is computed against the running version, not cached', async () => {
    const cache = memoryCache<CachedRelease>(() => 1_000_000);
    await setup({ cache }).provider.check();
    const after = setup({ cache, currentVersion: '0.2.1' });
    expect(await after.provider.check()).toMatchObject({ ok: true, value: { latest: '0.2.1', isNewer: false } });
    expect(after.calls).toHaveLength(0);
  });

  it('stale fallback on failure (status or thrown); cache errors are tolerated', async () => {
    let fail: 'status' | 'throw' | null = null;
    const s = setup({ reply: () => { if (fail === 'throw') throw new Error('down'); return fail ? { status: 503, headers: {}, data: {} } : ok(FX.releases); } });
    await s.provider.check();
    s.advance(UPDATE_CACHE_TTL_MS);
    fail = 'status';
    expect(await s.provider.check()).toEqual(expect.objectContaining({ ok: true, stale: true, value: expect.objectContaining({ latest: '0.2.1' }) }));
    fail = 'throw';
    expect(await s.provider.check()).toMatchObject({ ok: true, stale: true });
    const broken = setup({ cache: { get: () => { throw new Error('io'); }, set: () => { throw new Error('io'); } } });
    expect(await broken.provider.check()).toMatchObject({ ok: true, value: { latest: '0.2.1' } });
    const none = setup({ cache: undefined as never, reply: () => ok(FX.releases) });
    expect(await none.provider.check()).toMatchObject({ ok: true });
  });

  it('works without any cache', async () => {
    const transport: HttpTransport = vi.fn(async () => ok(FX.releases));
    const p = createUpdateCheckProvider({ transport, enabled: () => true, currentVersion: '0.2.0' });
    await p.check();
    await p.check();
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
