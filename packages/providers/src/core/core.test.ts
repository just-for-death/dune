import { describe, it, expect, vi } from 'vitest';
import { memoryCache, isFresh } from './cache.js';
import { ProviderError, codeForStatus, failure, success, isProviderError } from './errors.js';
import { gated, isEnabled, resolveKey } from './gating.js';
import { assertAllowedUrl, createGuardedClient, isHostAllowed, DEFAULT_MAX_BYTES } from './guard.js';
import { checkImageResponse } from './image.js';
import { redactHeaders, redactText, redactUrl, safeErrorMessage, REDACTED } from './redact.js';
import type { HttpRequest, HttpResponse, HttpTransport } from './types.js';

const res = (status: number, headers: Record<string, string> = {}, data: unknown = {}): HttpResponse => ({ status, headers, data });

describe('allow-list', () => {
  it('exact hosts and *.suffix wildcards', () => {
    const hosts = ['howlongtobeat.com', '*.steamgriddb.com'];
    expect(isHostAllowed('howlongtobeat.com', hosts)).toBe(true);
    expect(isHostAllowed('HowLongToBeat.com.', hosts)).toBe(true);
    expect(isHostAllowed('evil-howlongtobeat.com', hosts)).toBe(false);
    expect(isHostAllowed('www.howlongtobeat.com', hosts)).toBe(false);
    expect(isHostAllowed('cdn2.steamgriddb.com', hosts)).toBe(true);
    expect(isHostAllowed('steamgriddb.com', hosts)).toBe(false);
    expect(isHostAllowed('steamgriddb.com.evil.io', hosts)).toBe(false);
  });

  it('https only, no userinfo, no odd ports, valid URLs only', () => {
    const hosts = ['a.example'];
    expect(assertAllowedUrl('https://a.example/x', hosts).pathname).toBe('/x');
    expect(assertAllowedUrl('https://a.example:443/x', hosts).hostname).toBe('a.example');
    for (const bad of ['http://a.example/', 'https://u:p@a.example/', 'https://a.example:8443/', 'https://b.example/', 'not a url', 'file:///etc/passwd']) {
      expect(() => assertAllowedUrl(bad, hosts)).toThrow(expect.objectContaining({ code: 'PROVIDER_HOST_BLOCKED' }));
    }
  });
});

describe('guarded client', () => {
  it('blocked host: the transport is never called', async () => {
    const transport = vi.fn<HttpTransport>();
    const c = createGuardedClient({ provider: 'hltb', hosts: ['a.example'], transport });
    await expect(c.request('https://evil.example/')).rejects.toMatchObject({ code: 'PROVIDER_HOST_BLOCKED' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('applies default timeout / maxBytes / responseType and passes headers + body', async () => {
    const transport = vi.fn<HttpTransport>(async () => res(200));
    const c = createGuardedClient({ provider: 'hltb', hosts: ['a.example'], transport, timeoutMs: 1234 });
    await c.request('https://a.example/p', { method: 'POST', headers: { A: '1' }, body: { q: 1 } });
    expect(transport.mock.calls[0]![0]).toEqual({ method: 'POST', url: 'https://a.example/p', headers: { A: '1' }, body: { q: 1 }, responseType: 'json', timeoutMs: 1234, maxBytes: DEFAULT_MAX_BYTES });
  });

  it('follows allowed redirects (303 -> GET), re-checks every hop, caps hops', async () => {
    const seen: HttpRequest[] = [];
    const transport: HttpTransport = async (req) => {
      seen.push(req);
      if (req.url.endsWith('/start')) return res(303, { location: '/next' });
      if (req.url.endsWith('/next')) return res(302, { location: 'https://b.example/final' });
      return res(200, {}, 'done');
    };
    const c = createGuardedClient({ provider: 'hltb', hosts: ['a.example', 'b.example'], transport });
    expect((await c.request('https://a.example/start', { method: 'POST', body: { x: 1 } })).data).toBe('done');
    expect(seen.map((r) => [r.method, r.url, r.body])).toEqual([
      ['POST', 'https://a.example/start', { x: 1 }],
      ['GET', 'https://a.example/next', undefined],
      ['GET', 'https://b.example/final', undefined],
    ]);

    const warn = vi.fn();
    const toEvil = createGuardedClient({ provider: 'hltb', hosts: ['a.example'], transport: async () => res(301, { location: 'https://evil.example/' }), logger: { info: () => {}, warn } });
    await expect(toEvil.request('https://a.example/')).rejects.toMatchObject({ code: 'PROVIDER_HOST_BLOCKED' });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ code: 'PROVIDER_HOST_BLOCKED' }), 'Provider redirect blocked');

    const loop = createGuardedClient({ provider: 'hltb', hosts: ['a.example'], transport: async () => res(307, { location: '/again' }) });
    await expect(loop.request('https://a.example/')).rejects.toMatchObject({ code: 'PROVIDER_BAD_RESPONSE' });
    const noLocation = createGuardedClient({ provider: 'hltb', hosts: ['a.example'], transport: async () => res(302) });
    expect((await noLocation.request('https://a.example/')).status).toBe(302);
  });

  it('transport failures become ProviderError with redacted logs; transport codes are kept', async () => {
    const warn = vi.fn();
    const c = createGuardedClient({
      provider: 'steam', hosts: ['a.example'], logger: { info: () => {}, warn }, secrets: () => ['KEY-abcdef'],
      transport: async () => { throw new Error('failed GET https://a.example/x?key=KEY-abcdef'); },
    });
    const err = await c.request('https://a.example/x?key=KEY-abcdef').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(JSON.stringify(warn.mock.calls) + String((err as Error).message)).not.toContain('KEY-abcdef');
    const t = createGuardedClient({ provider: 'hltb', hosts: ['a.example'], transport: async () => { throw new ProviderError('PROVIDER_TIMEOUT', 'slow'); } });
    await expect(t.request('https://a.example/')).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
  });
});

describe('gating + keys', () => {
  it('disabled runs nothing; errors become typed failures', async () => {
    const fn = vi.fn(async () => success(1));
    expect(await gated('steam', () => false, fn)).toEqual({ ok: false, code: 'PROVIDER_DISABLED', message: 'steam is disabled' });
    expect(fn).not.toHaveBeenCalled();
    expect(await gated('steam', async () => true, fn)).toEqual({ ok: true, value: 1 });
    expect(await gated('steam', () => true, async () => { throw new ProviderError('PROVIDER_TOO_LARGE', 'big'); })).toEqual(failure('PROVIDER_TOO_LARGE', 'big'));
    expect(await gated('steam', () => true, async () => { throw new Error('boom KEY'); })).toEqual(failure('PROVIDER_UNAVAILABLE', 'steam failed'));
    expect(await isEnabled(() => { throw new Error('x'); })).toBe(false);
  });

  it('resolveKey: missing, empty, throwing, present', async () => {
    expect(await resolveKey('steamgriddb', undefined)).toMatchObject({ ok: false, code: 'PROVIDER_KEY_MISSING' });
    expect(await resolveKey('steamgriddb', () => '')).toMatchObject({ ok: false, code: 'PROVIDER_KEY_MISSING' });
    expect(await resolveKey('steamgriddb', () => { throw new Error('locked'); })).toMatchObject({ ok: false });
    expect(await resolveKey('steamgriddb', async () => 'k123')).toEqual({ ok: true, key: 'k123' });
  });

  it('errors helpers', () => {
    expect([404, 429, 401, 403, 500].map(codeForStatus)).toEqual(['PROVIDER_NOT_FOUND', 'PROVIDER_RATE_LIMITED', 'PROVIDER_KEY_MISSING', 'PROVIDER_KEY_MISSING', 'PROVIDER_UNAVAILABLE']);
    expect(success(1, true)).toEqual({ ok: true, value: 1, stale: true });
    expect(isProviderError(new ProviderError('PROVIDER_NOT_FOUND', 'x', 404))).toBe(true);
    expect(new ProviderError('PROVIDER_NOT_FOUND', 'x', 404).status).toBe(404);
    expect(isProviderError(new Error('x'))).toBe(false);
  });
});

describe('redaction', () => {
  it('urls: params, userinfo, secrets; text: bearer and pairs; headers', () => {
    expect(redactUrl('https://u:p@retroachievements.org/API/x.php?y=abc123&u=jane&key=k')).toBe(`https://retroachievements.org/API/x.php?y=${REDACTED}&u=jane&key=${REDACTED}`);
    expect(redactUrl('nope token=abc')).toBe(`nope token=${REDACTED}`);
    expect(redactUrl('https://a.example/abcd1234', ['abcd1234'])).toBe(`https://a.example/${REDACTED}`);
    expect(redactText('Authorization: Bearer abc.def https://me:pw@x.io api_key=zz', [])).toBe(`Authorization: Bearer ${REDACTED} https://${REDACTED}@x.io api_key=${REDACTED}`);
    expect(redactText('short ab', ['ab'])).toBe('short ab'); // too short to be a key; not blanked
    expect(redactHeaders({ Authorization: 'Bearer x', 'x-auth-token': 't', Accept: 'json' })).toEqual({ Authorization: REDACTED, 'x-auth-token': REDACTED, Accept: 'json' });
    expect(redactHeaders(undefined)).toEqual({});
    expect(safeErrorMessage('plain secret-1', ['secret-1'])).toBe(`plain ${REDACTED}`);
  });
});

describe('cache', () => {
  it('memoryCache stores with time; isFresh honours ttl; clear empties', () => {
    let t = 100;
    const c = memoryCache<number>(() => t);
    c.set('a', 1);
    expect(c.get('a')).toEqual({ value: 1, storedAt: 100 });
    t = 150;
    expect(isFresh(c.get('a')!, 60, t)).toBe(true);
    expect(isFresh(c.get('a')!, 50, t)).toBe(false);
    c.clear();
    expect(c.get('a')).toBeNull();
  });
});

describe('DUN-027: image checks', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const webp = new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ');
  it('accepts matching raster images', () => {
    expect(checkImageResponse(res(200, { 'content-type': 'image/png' }, png))).toMatchObject({ ok: true, value: { contentType: 'image/png' } });
    expect(checkImageResponse(res(200, { 'content-type': 'image/jpeg; charset=binary' }, jpg))).toMatchObject({ ok: true });
    expect(checkImageResponse(res(200, { 'content-type': 'image/webp' }, webp))).toMatchObject({ ok: true });
  });
  it('rejects status, svg/html, oversize, non-bytes and mismatched magic', () => {
    expect(checkImageResponse(res(404, {}, png))).toMatchObject({ code: 'PROVIDER_NOT_FOUND' });
    expect(checkImageResponse(res(500, {}, png))).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(checkImageResponse(res(200, { 'content-type': 'image/svg+xml' }, png))).toMatchObject({ code: 'PROVIDER_BAD_CONTENT_TYPE' });
    expect(checkImageResponse(res(200, {}, png))).toMatchObject({ code: 'PROVIDER_BAD_CONTENT_TYPE' });
    expect(checkImageResponse(res(200, { 'content-type': 'image/png', 'content-length': '999999999' }, png))).toMatchObject({ code: 'PROVIDER_TOO_LARGE' });
    expect(checkImageResponse(res(200, { 'content-type': 'image/png' }, png), { maxBytes: 4 })).toMatchObject({ code: 'PROVIDER_TOO_LARGE' });
    expect(checkImageResponse(res(200, { 'content-type': 'image/png' }, 'text'))).toMatchObject({ code: 'PROVIDER_BAD_RESPONSE' });
    expect(checkImageResponse(res(200, { 'content-type': 'image/png' }, jpg))).toMatchObject({ code: 'PROVIDER_BAD_CONTENT_TYPE' });
    expect(checkImageResponse(res(200, { 'content-type': 'image/png' }, png), { types: ['image/jpeg'] })).toMatchObject({ code: 'PROVIDER_BAD_CONTENT_TYPE' });
  });
});
