import { describe, it, expect } from 'vitest';
import { isProviderError, type FetchLike } from '@dune/providers';
import { createLocalTransport } from './transport';
import { fakeFetch, json } from './testHelpers';

const req = { method: 'GET' as const, url: 'https://www.steamgriddb.com/api/v2/x?key=SECRET', responseType: 'json' as const, timeoutMs: 1000, maxBytes: 1024 };

describe('local transport', () => {
  it('passes the request to the injected fetch with redirect: manual and returns any status', async () => {
    const f = fakeFetch(() => json({ success: false }, 404));
    const res = await createLocalTransport(f)(req);
    expect(res).toMatchObject({ status: 404, data: { success: false } });
    expect(res.headers['content-type']).toBe('application/json');
    expect(f.calls[0].url).toBe(req.url);
  });

  it('turns raw fetch errors into PROVIDER_UNAVAILABLE without the URL or cause', async () => {
    const f = fakeFetch(() => { throw new Error(`net::ERR_FAILED ${req.url}`); });
    const err = await createLocalTransport(f)(req).catch((e: unknown) => e);
    expect(isProviderError(err) && err.code).toBe('PROVIDER_UNAVAILABLE');
    expect(String((err as Error).message)).not.toContain('SECRET');
  });

  it('keeps ProviderErrors (timeout, too large) from the package transport', async () => {
    const hang: FetchLike = (_url, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
    const err = await createLocalTransport(hang)({ ...req, timeoutMs: 10 }).catch((e: unknown) => e);
    expect(isProviderError(err) && err.code).toBe('PROVIDER_TIMEOUT');
    const big = fakeFetch(() => new Response('x'.repeat(2048)));
    const err2 = await createLocalTransport(big)(req).catch((e: unknown) => e);
    expect(isProviderError(err2) && err2.code).toBe('PROVIDER_TOO_LARGE');
  });
});
