import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import { memoryCache } from '../core/cache.js';
import { ProviderError } from '../core/errors.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../core/types.js';
import { buildManifestIndex, findManifestGame, pcgamingwikiPageUrl } from './lookup.js';
import { parseManifestYaml } from './parse.js';
import {
  createManifestProvider, LUDUSAVI_MANIFEST_URL, MANIFEST_ATTRIBUTION, MANIFEST_CACHE_TTL_MS, MANIFEST_DEFAULT_MAX_BYTES,
  MANIFEST_MAX_BYTES_LIMIT, MANIFEST_RETRY_MS, MANIFEST_TIMEOUT_MS, type CachedManifest, type ManifestProviderOptions,
} from './provider.js';

const YAML = fs.readFileSync(new URL('./manifest.fixture.yaml', import.meta.url), 'utf-8');
const ok = (data: unknown, headers: Record<string, string> = { 'content-type': 'text/plain; charset=utf-8', etag: '"v1"' }): HttpResponse => ({ status: 200, headers, data });
const status = (s: number, headers: Record<string, string> = {}): HttpResponse => ({ status: s, headers, data: '' });

function setup(o: Partial<ManifestProviderOptions> & { reply?: (req: HttpRequest) => HttpResponse | Promise<HttpResponse> } = {}) {
  const calls: HttpRequest[] = [];
  const reply = o.reply ?? (() => ok(YAML));
  const transport: HttpTransport = vi.fn(async (req: HttpRequest) => { calls.push(req); return reply(req); });
  let t = 1_000_000;
  const now = () => t;
  const mem = memoryCache<CachedManifest>(now);
  const cache = o.cache ?? mem;
  const provider = createManifestProvider({ transport, enabled: () => true, now, cache, ...o });
  return { provider, calls, transport, cache, mem, advance: (ms: number) => { t += ms; } };
}

const parse = (text: string, maxBytes = 1 << 20) => parseManifestYaml(text, { maxBytes });
const badResponse = (fn: () => unknown, msg: RegExp) => {
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(ProviderError); expect((e as ProviderError).code).toBe('PROVIDER_BAD_RESPONSE'); expect((e as Error).message).toMatch(msg); return; }
  throw new Error('expected a throw');
};

describe('manifest: parse (js-yaml CORE_SCHEMA + Zod)', () => {
  it('validates games, strips launch and unknown fields, skips invalid entries', () => {
    const { games, skipped } = parse(YAML);
    expect(skipped).toBe(2);
    expect(Object.keys(games)).toEqual(['! That Bastard Is Trying To Steal Our Gold !', '!Anyway!', 'Hollow Knight', 'HK', 'Alias Of Alias', 'Broken Alias']);
    const bastard = games['! That Bastard Is Trying To Steal Our Gold !']!;
    expect(bastard).not.toHaveProperty('launch');
    expect(JSON.stringify(games)).not.toMatch(/TDTTSOG\.exe|--evil/);
    expect(bastard.installDir).toEqual(['! That Bastard Is Trying To Steal Our Gold !']);
    expect(bastard.registry).toEqual({ 'HKEY_CURRENT_USER/SOFTWARE/WTFOMGames/That Dick Trying To Steal Our Gold': { tags: ['config', 'save'] } });
    const anyway = games['!Anyway!']!;
    expect(anyway.files).toEqual({ '<winLocalAppData>/anyway': { tags: ['save'], when: [{ os: 'windows' }] }, '<home>/.config/anyway': {} });
    expect(anyway.cloud).toEqual({ steam: true });
    expect(games['Hollow Knight']).not.toHaveProperty('futureField');
    expect(games['Hollow Knight']!.notes).toEqual([{ message: 'Steam Cloud also syncs saves.' }]);
  });

  it('never evaluates custom or js types', () => {
    for (const tag of ['!!js/function "function () { return 1 }"', '!!js/regexp /x/', '!!js/undefined ""', '!custom 1', '!!binary aGk=', '!!timestamp 2020-01-01']) {
      badResponse(() => parse(`Game:\n  steam:\n    id: ${tag}\n`), /not valid YAML/);
    }
  });

  it('rejects anchors/aliases (billion laughs), merge keys stay inert, __proto__, duplicates, deep nesting', () => {
    const laughs = ['a: &a { notes: [{ message: x }] }', 'b: &b [*a, *a]', 'c: [*b, *b]'].join('\n');
    badResponse(() => parse(laughs), /aliases/);
    // <<: is a plain key under CORE_SCHEMA, so the alias is still caught.
    badResponse(() => parse('base: &base { steam: { id: 1 } }\nGame:\n  <<: *base\n'), /aliases/);
    badResponse(() => parse('"__proto__":\n  steam:\n    id: 1\n'), /__proto__/);
    badResponse(() => parse('Game:\n  files:\n    "__proto__": {}\n'), /__proto__/);
    badResponse(() => parse('Game: {}\nGame: {}\n'), /not valid YAML/);
    badResponse(() => parse(`Game:\n  notes: ${'['.repeat(20)}${']'.repeat(20)}\n`), /too deeply/);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('rejects non-mapping documents, empty manifests, too many games and oversize text', () => {
    for (const doc of ['', '- a\n- b\n', 'just a string', '42', 'null']) badResponse(() => parse(doc), /mapping of game titles/);
    badResponse(() => parse('Bad: { steam: { id: -1 } }\n'), /no valid games/);
    badResponse(() => parseManifestYaml('A: {}\nB: {}\nC: {}\n', { maxBytes: 1000, maxGames: 2 }), /more than 2 games/);
    expect(() => parse(YAML, 100)).toThrow(expect.objectContaining({ code: 'PROVIDER_TOO_LARGE' }));
    badResponse(() => parse('Game: [unclosed\n'), /not valid YAML/);
  });

  it('bounds names, paths and entry counts per game', () => {
    const long = 'x'.repeat(513);
    expect(parse(`"${long}": {}\nOk: {}\n`).skipped).toBe(1);
    expect(parse(`Game:\n  files:\n    "${'p'.repeat(1025)}": {}\nOk: {}\n`).skipped).toBe(1);
    expect(parse('Game:\n  files:\n    "a\\u0000b": {}\nOk: {}\n').skipped).toBe(1);
    const many = Array.from({ length: 501 }, (_, i) => `    "<base>/f${i}": {}`).join('\n');
    expect(parse(`Game:\n  files:\n${many}\nOk: {}\n`).skipped).toBe(1);
    expect(parse('Game: ~\n').games).toEqual({ Game: {} });
  });
});

describe('manifest: lookup', () => {
  const { games } = parse(YAML);
  const index = buildManifestIndex(games);
  it('finds by Steam id (incl. steamExtra), GOG id, or title; follows one alias hop', () => {
    expect(findManifestGame(games, index, { steamId: 367520 })?.name).toBe('Hollow Knight');
    expect(findManifestGame(games, index, { steamId: 867990 })?.name).toBe('!Anyway!');
    expect(findManifestGame(games, index, { gogId: 1308320804 })?.name).toBe('Hollow Knight');
    expect(findManifestGame(games, index, { title: '  hollow   KNIGHT ' })?.name).toBe('Hollow Knight');
    expect(findManifestGame(games, index, { title: 'hk' })?.name).toBe('Hollow Knight');
    expect(findManifestGame(games, index, { steamId: 1, title: 'Hollow Knight' })?.name).toBe('Hollow Knight');
    for (const q of [{ title: 'Alias Of Alias' }, { title: 'Broken Alias' }, { title: 'nope' }, { title: '   ' }, {}, { steamId: 42 }, { title: '__proto__' }]) {
      expect(findManifestGame(games, index, q)).toBeNull();
    }
  });
  it('builds PCGamingWiki page links', () => {
    expect(pcgamingwikiPageUrl('Hollow Knight')).toBe('https://www.pcgamingwiki.com/wiki/Hollow_Knight');
    expect(pcgamingwikiPageUrl('A/B?&#')).toBe('https://www.pcgamingwiki.com/wiki/A%2FB%3F%26%23');
  });
});

describe('manifest provider: config and gating', () => {
  it('rejects a byte cap outside 1..64 MiB', () => {
    for (const maxBytes of [0, -1, 1.5, MANIFEST_MAX_BYTES_LIMIT + 1]) {
      expect(() => createManifestProvider({ transport: vi.fn(), enabled: () => true, maxBytes })).toThrow(TypeError);
    }
  });

  it('disabled (false, non-boolean, throwing) -> PROVIDER_DISABLED, zero requests, no cache read', async () => {
    for (const enabled of [() => false, () => 'true' as unknown as boolean, () => { throw new Error('x'); }, async () => false]) {
      const get = vi.fn(() => null);
      const s = setup({ enabled, cache: { get, set: vi.fn() } });
      expect(await s.provider.getManifest()).toMatchObject({ ok: false, code: 'PROVIDER_DISABLED' });
      expect(await s.provider.lookup({ title: 'Hollow Knight' })).toMatchObject({ ok: false, code: 'PROVIDER_DISABLED' });
      expect(s.transport).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    }
  });
});

describe('manifest provider: download (fixture)', () => {
  it('GETs the fixed raw GitHub URL as text with caps, returns games with attribution', async () => {
    const { provider, calls } = setup();
    const r = await provider.getManifest();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', url: LUDUSAVI_MANIFEST_URL, responseType: 'text', maxBytes: MANIFEST_DEFAULT_MAX_BYTES, timeoutMs: MANIFEST_TIMEOUT_MS });
    expect(calls[0]!.headers?.['User-Agent']).toMatch(/^Dune-Manifest/);
    expect(calls[0]!.headers?.['If-None-Match']).toBeUndefined();
    if (!r.ok) throw new Error(r.message);
    expect(r.stale).toBeUndefined();
    expect(r.value.skipped).toBe(2);
    expect(r.value.etag).toBe('"v1"');
    expect(Object.keys(r.value.games)).toContain('Hollow Knight');
    expect(r.value.attribution).toEqual(MANIFEST_ATTRIBUTION);
    expect(r.value.attribution.text).toMatch(/PCGamingWiki.*CC BY-NC-SA 3\.0/);
    expect(r.value.attribution.licenseUrl).toBe('https://creativecommons.org/licenses/by-nc-sa/3.0/');
    expect(r.value.attribution.url).toBe('https://www.pcgamingwiki.com/');
  });

  it('lookup returns the game, its PCGamingWiki link and attribution; missing -> PROVIDER_NOT_FOUND', async () => {
    const { provider, calls } = setup();
    expect(await provider.lookup({ title: 'HK' })).toMatchObject({ ok: true, value: { title: 'Hollow Knight', pageUrl: 'https://www.pcgamingwiki.com/wiki/Hollow_Knight', attribution: MANIFEST_ATTRIBUTION } });
    expect(await provider.lookup({ steamId: 449940 })).toMatchObject({ ok: true, value: { title: '! That Bastard Is Trying To Steal Our Gold !' } });
    expect(await provider.lookup({ title: 'Unknown Game' })).toMatchObject({ ok: false, code: 'PROVIDER_NOT_FOUND' });
    expect(calls).toHaveLength(1);
  });

  it('shares one download between concurrent callers', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const s = setup({ reply: async () => { await gate; return ok(YAML); } });
    const both = Promise.all([s.provider.getManifest(), s.provider.lookup({ title: 'Hollow Knight' })]);
    release();
    const [a, b] = await both;
    expect(a.ok && b.ok).toBe(true);
    expect(s.calls).toHaveLength(1);
  });

  it('maps failures without a cache', async () => {
    const cases: [HttpResponse, string][] = [
      [status(404), 'PROVIDER_NOT_FOUND'], [status(429), 'PROVIDER_RATE_LIMITED'], [status(403), 'PROVIDER_UNAVAILABLE'],
      [status(401), 'PROVIDER_UNAVAILABLE'], [status(500), 'PROVIDER_UNAVAILABLE'], [status(304), 'PROVIDER_UNAVAILABLE'],
      [ok('<html></html>', { 'content-type': 'text/html' }), 'PROVIDER_BAD_CONTENT_TYPE'],
      [ok({ not: 'text' }), 'PROVIDER_BAD_RESPONSE'], [ok('- a list\n'), 'PROVIDER_BAD_RESPONSE'],
      [ok('Game: !!js/function "function(){}"\n'), 'PROVIDER_BAD_RESPONSE'],
    ];
    for (const [res, code] of cases) {
      const s = setup({ reply: () => res });
      expect(await s.provider.getManifest()).toMatchObject({ ok: false, code });
    }
    const s = setup({ reply: () => { throw new ProviderError('PROVIDER_TIMEOUT', 'timed out'); } });
    expect(await s.provider.getManifest()).toMatchObject({ ok: false, code: 'PROVIDER_TIMEOUT' });
    const u = setup({ reply: () => { throw new Error('boom'); } });
    expect(await u.provider.getManifest()).toMatchObject({ ok: false, code: 'PROVIDER_UNAVAILABLE' });
  });

  it('accepts YAML content types and a missing content-type; keeps no oversized ETag', async () => {
    for (const type of ['application/yaml', 'text/x-yaml', 'application/octet-stream']) {
      expect((await setup({ reply: () => ok(YAML, { 'content-type': type }) }).provider.getManifest()).ok).toBe(true);
    }
    const r = await setup({ reply: () => ok(YAML, { etag: `"${'e'.repeat(300)}"` }) }).provider.getManifest();
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.etag).toBeUndefined();
  });

  it('enforces the byte cap on the text it receives', async () => {
    const s = setup({ maxBytes: 64 });
    expect(await s.provider.getManifest()).toMatchObject({ ok: false, code: 'PROVIDER_TOO_LARGE' });
    expect(s.calls[0]!.maxBytes).toBe(64);
  });

  it('guard: a redirect off the allow-list is blocked; an allowed hop is followed', async () => {
    const off = setup({ reply: () => status(302, { location: 'https://evil.example.com/manifest.yaml' }) });
    expect(await off.provider.getManifest()).toMatchObject({ ok: false, code: 'PROVIDER_HOST_BLOCKED' });
    expect(off.calls).toHaveLength(1);
    const http = setup({ reply: () => status(301, { location: 'http://raw.githubusercontent.com/x' }) });
    expect(await http.provider.getManifest()).toMatchObject({ ok: false, code: 'PROVIDER_HOST_BLOCKED' });
    const on = setup({ reply: (req) => (req.url === LUDUSAVI_MANIFEST_URL ? status(302, { location: '/mtkennerly/ludusavi-manifest/main/data/manifest.yaml' }) : ok(YAML)) });
    expect((await on.provider.getManifest()).ok).toBe(true);
    expect(on.calls.map((c) => c.url)).toEqual([LUDUSAVI_MANIFEST_URL, 'https://raw.githubusercontent.com/mtkennerly/ludusavi-manifest/main/data/manifest.yaml']);
  });
});

describe('manifest provider: cache', () => {
  it('fresh cache -> no network (also from the injected cache in a new instance)', async () => {
    const s = setup();
    await s.provider.getManifest();
    s.advance(MANIFEST_CACHE_TTL_MS - 1);
    expect((await s.provider.getManifest()).ok).toBe(true);
    const again = setup({ cache: s.cache, now: () => 1_000_000 + 10 });
    expect(await again.provider.lookup({ steamId: 367520 })).toMatchObject({ ok: true, value: { title: 'Hollow Knight' } });
    expect(again.calls).toHaveLength(0);
    expect(s.calls).toHaveLength(1);
  });

  it('expired -> revalidates with If-None-Match; 304 keeps the data and refreshes the timestamp', async () => {
    const s = setup({ reply: (req) => (req.headers?.['If-None-Match'] === '"v1"' ? status(304) : ok(YAML)) });
    const first = await s.provider.getManifest();
    s.advance(MANIFEST_CACHE_TTL_MS);
    const second = await s.provider.getManifest();
    expect(s.calls).toHaveLength(2);
    expect(second).toMatchObject({ ok: true, value: { etag: '"v1"', fetchedAt: 1_000_000 + MANIFEST_CACHE_TTL_MS } });
    expect(second.ok && first.ok && second.value.games).toEqual(first.ok && first.value.games);
    expect(s.mem.get('ludusavi-manifest')?.value.fetchedAt).toBe(1_000_000 + MANIFEST_CACHE_TTL_MS);
    s.advance(1);
    await s.provider.getManifest();
    expect(s.calls).toHaveLength(2);
  });

  it('force bypasses the TTL', async () => {
    const s = setup();
    await s.provider.getManifest();
    await s.provider.getManifest({ force: true });
    expect(s.calls).toHaveLength(2);
  });

  it('refresh failure -> stale copy, then backs off before retrying', async () => {
    let fail = false;
    const s = setup({ reply: () => { if (fail) throw new Error('offline'); return ok(YAML); } });
    await s.provider.getManifest();
    fail = true;
    s.advance(MANIFEST_CACHE_TTL_MS);
    expect(await s.provider.getManifest()).toMatchObject({ ok: true, stale: true });
    expect(await s.provider.lookup({ title: 'Hollow Knight' })).toMatchObject({ ok: true, stale: true, value: { title: 'Hollow Knight' } });
    expect(s.calls).toHaveLength(2);
    s.advance(MANIFEST_RETRY_MS);
    fail = false;
    expect(await s.provider.getManifest()).toMatchObject({ ok: true });
    expect(s.calls).toHaveLength(3);
  });

  it('bad refresh (status or content) also falls back to the stale copy', async () => {
    let res = ok(YAML);
    const s = setup({ reply: () => res });
    await s.provider.getManifest();
    res = ok('- not a manifest\n');
    s.advance(MANIFEST_CACHE_TTL_MS);
    expect(await s.provider.getManifest()).toMatchObject({ ok: true, stale: true });
  });

  it('without a cache, a failure is remembered for the back-off window', async () => {
    const s = setup({ reply: () => status(500) });
    expect(await s.provider.getManifest()).toMatchObject({ ok: false, code: 'PROVIDER_UNAVAILABLE' });
    expect(await s.provider.getManifest()).toMatchObject({ ok: false, code: 'PROVIDER_UNAVAILABLE' });
    expect(s.calls).toHaveLength(1);
    const t = setup({ reply: () => { throw new ProviderError('PROVIDER_TIMEOUT', 'slow'); } });
    await t.provider.getManifest();
    expect(await t.provider.getManifest()).toMatchObject({ ok: false, code: 'PROVIDER_TIMEOUT' });
    const u = setup({ reply: () => { throw new Error('x'); } });
    await u.provider.getManifest();
    expect(await u.provider.getManifest()).toMatchObject({ ok: false, code: 'PROVIDER_UNAVAILABLE' });
    expect(u.calls).toHaveLength(1);
    await u.provider.getManifest({ force: true });
    expect(u.calls).toHaveLength(2);
  });

  it('a throwing cache is ignored on read and logged on write; works with no cache at all', async () => {
    const warn = vi.fn();
    const s = setup({ cache: { get: () => { throw new Error('r'); }, set: async () => { throw new Error('w'); } }, logger: { info: vi.fn(), warn } });
    expect((await s.provider.getManifest()).ok).toBe(true);
    expect(warn).toHaveBeenCalledWith({ provider: 'manifest', op: 'cache-write' }, 'Manifest cache write failed');
    const n = createManifestProvider({ transport: async () => ok(YAML), enabled: () => true });
    expect(await n.lookup({ title: 'hollow knight' })).toMatchObject({ ok: true });
  });

  it('lookup on a stale copy not held in memory still indexes it', async () => {
    const seed = setup();
    await seed.provider.getManifest();
    const entry = seed.mem.get('ludusavi-manifest')!;
    const s = setup({ cache: { get: () => ({ ...entry }), set: vi.fn() }, reply: () => status(500), now: () => entry.storedAt + MANIFEST_CACHE_TTL_MS });
    expect(await s.provider.lookup({ gogId: 1308320804 })).toMatchObject({ ok: true, stale: true, value: { title: 'Hollow Knight' } });
  });
});
