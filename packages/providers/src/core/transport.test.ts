import { describe, it, expect, vi } from 'vitest';
import { fetchTransport, type FetchLike } from './transport.js';
import type { HttpRequest } from './types.js';

function stream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({ pull(c) { if (i < chunks.length) c.enqueue(chunks[i++]!); else c.close(); } });
}
const enc = (s: string) => new TextEncoder().encode(s);
function fake(status: number, headers: Record<string, string>, chunks: Uint8Array[] | null): FetchLike {
  return vi.fn(async () => ({ status, headers: new Headers(headers), body: chunks ? stream(chunks) : null }));
}
const req = (over: Partial<HttpRequest> = {}): HttpRequest => ({ method: 'GET', url: 'https://a.example/', responseType: 'json', timeoutMs: 1000, maxBytes: 1024, ...over });

describe('fetchTransport', () => {
  it('json, json fallback to text, text, bytes, empty body; headers lower-cased', async () => {
    expect(await fetchTransport(fake(200, { 'X-A': '1' }, [enc('{"a":'), enc('1}')]))(req())).toEqual({ status: 200, headers: { 'x-a': '1' }, data: { a: 1 } });
    expect((await fetchTransport(fake(500, {}, [enc('oops')]))(req())).data).toBe('oops');
    expect((await fetchTransport(fake(200, {}, [enc('<html>')]))(req({ responseType: 'text' }))).data).toBe('<html>');
    expect((await fetchTransport(fake(200, {}, [new Uint8Array([1, 2])]))(req({ responseType: 'bytes' }))).data).toEqual(new Uint8Array([1, 2]));
    expect((await fetchTransport(fake(204, {}, null))(req({ responseType: 'text' }))).data).toBe('');
  });

  it('never follows redirects and JSON-encodes object bodies', async () => {
    const f = fake(302, { location: '/x' }, null);
    const r = await fetchTransport(f)(req({ method: 'POST', body: { q: 1 }, headers: { A: 'b' } }));
    expect(r.status).toBe(302);
    const init = vi.mocked(f).mock.calls[0]![1];
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', body: '{"q":1}', headers: { A: 'b', 'Content-Type': 'application/json' } });
    const f2 = fake(200, {}, null);
    await fetchTransport(f2)(req({ method: 'POST', body: 'raw', headers: { 'content-type': 'text/plain' } }));
    expect(vi.mocked(f2).mock.calls[0]![1]).toMatchObject({ body: 'raw', headers: { 'content-type': 'text/plain' } });
  });

  it('caps the body by content-length and by streamed size', async () => {
    await expect(fetchTransport(fake(200, { 'content-length': '5000' }, [enc('x')]))(req())).rejects.toMatchObject({ code: 'PROVIDER_TOO_LARGE' });
    await expect(fetchTransport(fake(200, {}, [new Uint8Array(600), new Uint8Array(600)]))(req())).rejects.toMatchObject({ code: 'PROVIDER_TOO_LARGE' });
  });

  it('times out with PROVIDER_TIMEOUT; other errors pass through', async () => {
    const hang: FetchLike = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    await expect(fetchTransport(hang)(req({ timeoutMs: 10 }))).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    await expect(fetchTransport(async () => { throw new Error('ECONNREFUSED'); })(req())).rejects.toThrow('ECONNREFUSED');
  });

  it('defaults to the global fetch', () => {
    expect(typeof fetchTransport()).toBe('function');
  });
});
