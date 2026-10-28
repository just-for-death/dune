import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createServerClient, type ServerHttp } from '../net/serverClient';
import { MAX_ART_BYTES, fetchArtViaServer, isAllowedArtUrl } from './fetchArt';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function thumbDir() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-art-')); dirs.push(d); return d; }

function setup(searchResult: unknown, image: { status?: number; type?: string; bytes?: number } = {}) {
  const serverCalls: Record<string, unknown>[] = [];
  const imageCalls: Record<string, unknown>[] = [];
  const serverHttp = {
    request: vi.fn(async (cfg: Record<string, unknown>) => {
      serverCalls.push(cfg);
      if (searchResult instanceof Error) throw searchResult;
      return { status: 200, data: searchResult };
    }),
  } as unknown as ServerHttp;
  const http = {
    request: vi.fn(async (cfg: Record<string, unknown>) => {
      imageCalls.push(cfg);
      return { status: 200, headers: { 'content-type': image.type ?? 'image/png' }, data: new Uint8Array(image.bytes ?? 4).buffer };
    }),
  } as unknown as ServerHttp;
  const client = createServerClient({ http: serverHttp, baseUrl: () => 'http://nas:3030', apiKey: () => 'dune-key' });
  return { client, http, serverCalls, imageCalls };
}

describe('game:fetchArt via the server (DUN-092)', () => {
  it('asks the server, downloads an https steamgriddb image without the API key, and writes the thumbnail', async () => {
    const dir = thumbDir();
    const { client, http, serverCalls, imageCalls } = setup({ success: true, results: ['https://cdn2.steamgriddb.com/grid/abc.png'] });
    const res = await fetchArtViaServer(7, 'Hades', { client, http, thumbDir: dir, writeFile: fs.writeFileSync });
    expect(res).toEqual({ ok: true, thumbnail: `local://${path.join(dir, '7.png')}` });
    expect(serverCalls[0]).toMatchObject({ url: 'http://nas:3030/api/search-art', params: { query: 'Hades' } });
    expect(imageCalls[0]).toMatchObject({ url: 'https://cdn2.steamgriddb.com/grid/abc.png', maxRedirects: 0, maxContentLength: MAX_ART_BYTES });
    expect(imageCalls[0].headers).toBeUndefined();
    expect(fs.readdirSync(dir)).toEqual(['7.png']);
  });

  it('PROVIDER_KEY_NOT_SET and 403 pass through unchanged; nothing is downloaded', async () => {
    const err = Object.assign(new Error('x'), { isAxiosError: true, request: {}, response: { status: 400, data: { error: 'No SteamGridDB key', code: 'PROVIDER_KEY_NOT_SET' } } });
    const { client, http, imageCalls } = setup(err);
    expect(await fetchArtViaServer(1, 'X', { client, http, thumbDir: thumbDir(), writeFile: vi.fn() }))
      .toEqual({ ok: false, status: 400, code: 'PROVIDER_KEY_NOT_SET', message: 'No SteamGridDB key' });
    expect(imageCalls).toEqual([]);
  });

  it('refuses non-SteamGridDB hosts, non-images and empty results', async () => {
    const writeFile = vi.fn();
    for (const url of ['http://cdn2.steamgriddb.com/a.png', 'https://evil.com/a.png', 'https://steamgriddb.com.evil.com/a.png', 'file:///etc/passwd', 'https://u:p@cdn.steamgriddb.com/a.png']) {
      const { client, http, imageCalls } = setup({ results: [url] });
      expect(await fetchArtViaServer(1, 'X', { client, http, thumbDir: thumbDir(), writeFile })).toMatchObject({ ok: false, code: 'ART_URL_REJECTED' });
      expect(imageCalls).toEqual([]);
    }
    const html = setup({ results: ['https://cdn2.steamgriddb.com/a.png'] }, { type: 'text/html' });
    expect(await fetchArtViaServer(1, 'X', { client: html.client, http: html.http, thumbDir: thumbDir(), writeFile })).toMatchObject({ ok: false, code: 'ART_NOT_IMAGE' });
    const none = setup({ results: [] });
    expect(await fetchArtViaServer(1, 'X', { client: none.client, http: none.http, thumbDir: thumbDir(), writeFile })).toMatchObject({ ok: false, code: 'ART_NOT_FOUND' });
    expect(writeFile).not.toHaveBeenCalled();
    expect(isAllowedArtUrl('https://steamgriddb.com/x.jpg')).toBe(true);
  });
});
