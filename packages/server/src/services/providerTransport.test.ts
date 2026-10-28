import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('axios');
import axios from 'axios';
import { axiosTransport } from './providerTransport.js';
import type { HttpRequest } from '@dune/providers';

const getMock = vi.mocked(axios.get);
const postMock = vi.mocked(axios.post);
const req = (over: Partial<HttpRequest> = {}): HttpRequest => ({ method: 'GET', url: 'https://howlongtobeat.com/', responseType: 'json', timeoutMs: 1000, maxBytes: 2048, ...over });

beforeEach(() => { getMock.mockReset(); postMock.mockReset(); });

describe('axiosTransport (@dune/providers HttpTransport over axios)', () => {
  it('returns every status, never follows redirects, passes timeout/size caps and headers', async () => {
    getMock.mockResolvedValue({ status: 302, headers: { Location: '/x', 'Set-Cookie': ['a', 'b'] }, data: '' });
    const res = await axiosTransport(req({ headers: { A: '1' }, responseType: 'text' }));
    expect(res).toEqual({ status: 302, headers: { location: '/x', 'set-cookie': 'a, b' }, data: '' });
    expect(getMock.mock.calls[0]![1]).toMatchObject({ timeout: 1000, maxRedirects: 0, maxContentLength: 2048, responseType: 'text', headers: { A: '1' } });
    expect((getMock.mock.calls[0]![1] as { validateStatus: (s: number) => boolean }).validateStatus(500)).toBe(true);
  });

  it('POSTs the body; AxiosHeaders are flattened; bytes become Uint8Array', async () => {
    postMock.mockResolvedValue({ status: 200, headers: { toJSON: () => ({ 'Content-Type': 'application/json', 'X-Null': null }) } /* AxiosHeaders shape */, data: { ok: 1 } });
    expect(await axiosTransport(req({ method: 'POST', body: { q: 1 } }))).toMatchObject({ status: 200, headers: { 'content-type': 'application/json' }, data: { ok: 1 } });
    expect(postMock.mock.calls[0]![1]).toEqual({ q: 1 });
    getMock.mockResolvedValue({ status: 200, headers: undefined, data: new Uint8Array([1, 2]).buffer });
    const bytes = await axiosTransport(req({ responseType: 'bytes' }));
    expect(bytes.data).toEqual(new Uint8Array([1, 2]));
    expect(getMock.mock.calls[0]![1]).toMatchObject({ responseType: 'arraybuffer' });
  });

  it('maps timeouts and size caps to typed ProviderErrors; other errors pass through', async () => {
    getMock.mockRejectedValueOnce(Object.assign(new Error('timeout of 1000ms exceeded'), { code: 'ECONNABORTED' }));
    await expect(axiosTransport(req())).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    getMock.mockRejectedValueOnce(new Error('maxContentLength size of 2048 exceeded'));
    await expect(axiosTransport(req())).rejects.toMatchObject({ code: 'PROVIDER_TOO_LARGE' });
    getMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(axiosTransport(req())).rejects.toThrow('ECONNREFUSED');
  });
});
