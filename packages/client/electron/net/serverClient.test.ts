import { describe, it, expect, vi } from 'vitest';
import { createServerClient, seg, type ServerHttp } from './serverClient';
import { SERVER_TIMEOUT_MS, TRANSFER_TIMEOUT_MS, toServerFailure } from './serverError';

// Fake axios instance; no network.
function fakeHttp(respond: (cfg: Record<string, unknown>) => unknown = () => ({ data: { success: true }, status: 200 })) {
  const calls: Record<string, unknown>[] = [];
  const http = {
    request: vi.fn(async (cfg: Record<string, unknown>) => {
      calls.push(cfg);
      const r = respond(cfg);
      if (r instanceof Error) throw r;
      return r;
    }),
  } as unknown as ServerHttp;
  return { http, calls };
}

describe('serverClient (DUN-121 gated URL)', () => {
  it('no saved URL: NO_SERVER and no request at all', async () => {
    const { http, calls } = fakeHttp();
    const client = createServerClient({ http, baseUrl: () => null, apiKey: () => 'k' });
    expect(await client.call({ method: 'GET', path: '/api/saves' })).toEqual({ ok: false, code: 'NO_SERVER', message: 'No Dune Server configured' });
    expect(calls).toEqual([]);
  });

  it('uses only the gated base URL, adds x-api-key and JSON content type', async () => {
    const { http, calls } = fakeHttp();
    const client = createServerClient({ http, baseUrl: () => 'http://nas:3030', apiKey: () => 'secret' });
    expect(await client.call({ method: 'POST', path: '/api/save-versions', body: { gameId: 7 } })).toEqual({ ok: true, success: true });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'http://nas:3030/api/save-versions',
      data: { gameId: 7 },
      headers: { 'x-api-key': 'secret', 'Content-Type': 'application/json' },
    });
  });

  it('omits the key header when no key is stored and drops undefined query values', async () => {
    const { http, calls } = fakeHttp();
    const client = createServerClient({ http, baseUrl: () => 'http://nas:3030', apiKey: () => '' });
    await client.call({ method: 'GET', path: '/api/playtime', query: { game: undefined } });
    expect((calls[0].headers as Record<string, string>)['x-api-key']).toBeUndefined();
    expect(calls[0].params).toBeUndefined();
  });

  it('refuses paths that are not /api/ or contain dot segments', async () => {
    const { http, calls } = fakeHttp();
    const client = createServerClient({ http, baseUrl: () => 'http://nas:3030', apiKey: () => '' });
    for (const path of ['/health', '/api/../admin', '/api/a/./b', 'api/x', '/api/x?y=1']) {
      const res = await client.call({ method: 'GET', path });
      expect(res).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    }
    expect(calls).toEqual([]);
  });
});

describe('timeouts (DUN-068)', () => {
  it('every request has a timeout; transfers get the longer one', async () => {
    const { http, calls } = fakeHttp();
    const client = createServerClient({ http, baseUrl: () => 'http://nas:3030', apiKey: () => '' });
    await client.call({ method: 'GET', path: '/api/manifest' });
    await client.call({ method: 'GET', path: '/api/download-file', transfer: true, responseType: 'arraybuffer' });
    expect(calls[0].timeout).toBe(SERVER_TIMEOUT_MS);
    expect(calls[1].timeout).toBe(TRANSFER_TIMEOUT_MS);
    expect(calls[1].responseType).toBe('arraybuffer');
    expect(SERVER_TIMEOUT_MS).toBeGreaterThan(0);
    expect(TRANSFER_TIMEOUT_MS).toBeGreaterThan(SERVER_TIMEOUT_MS);
  });

  it('a timed-out request resolves to NETWORK (no status) with a timeout message', async () => {
    const timeout = Object.assign(new Error('timeout of 15000ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED', request: {} });
    const { http } = fakeHttp(() => timeout);
    const client = createServerClient({ http, baseUrl: () => 'http://nas:3030', apiKey: () => '' });
    const res = await client.call({ method: 'GET', path: '/api/saves' });
    expect(res).toEqual({ ok: false, code: 'NETWORK', message: 'The Dune Server did not answer in time (request timed out).' });
    expect(toServerFailure(Object.assign(new Error('x'), { isAxiosError: true, code: 'ETIMEDOUT' })).code).toBe('NETWORK');
  });

  it('raw() rejects so multi-step flows (sync) end instead of hanging', async () => {
    const timeout = Object.assign(new Error('timeout'), { isAxiosError: true, code: 'ECONNABORTED', request: {} });
    const { http } = fakeHttp(() => timeout);
    const client = createServerClient({ http, baseUrl: () => 'http://nas:3030', apiKey: () => '' });
    await expect(client.raw({ method: 'GET', path: '/api/manifest' })).rejects.toBe(timeout);
  });
});

describe('seg (DUN-072)', () => {
  it('encodes a segment and refuses empty, . and ..', () => {
    expect(seg('a/b?c')).toBe('a%2Fb%3Fc');
    expect(seg(42)).toBe('42');
    for (const bad of ['', '.', '..']) expect(() => seg(bad)).toThrow('Invalid id');
  });
});
