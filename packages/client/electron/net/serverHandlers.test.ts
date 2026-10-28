import { describe, it, expect, vi } from 'vitest';
import { createServerClient, type ServerHttp } from './serverClient';
import { createServerIpcHandlers } from './serverHandlers';

function setup(respond: (cfg: Record<string, unknown>) => unknown = () => ({ data: { success: true }, status: 200 }), artOn = true) {
  const calls: Record<string, unknown>[] = [];
  const http = {
    request: vi.fn(async (cfg: Record<string, unknown>) => {
      calls.push(cfg);
      const r = respond(cfg);
      if (r instanceof Error) throw r;
      return r;
    }),
  } as unknown as ServerHttp;
  const handlers = createServerIpcHandlers(createServerClient({ http, baseUrl: () => 'http://nas:3030', apiKey: () => 'k' }), { artworkEnabled: () => artOn });
  return { handlers, calls };
}

function httpError(status: number, data: unknown) {
  return Object.assign(new Error(`Request failed with status code ${status}`), { isAxiosError: true, request: {}, response: { status, data } });
}

describe('server IPC arguments (DUN-072)', () => {
  it('ids must be positive integers; ../ never reaches a DELETE URL', async () => {
    const { handlers, calls } = setup();
    for (const channel of ['local-sources:remove', 'remote-servers:remove']) {
      for (const bad of ['../api-keys/abc', '1/../../x', 1.5, -1, 0, NaN, '7', null, {}]) {
        expect(await handlers[channel]({}, bad)).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
      }
    }
    expect(calls).toEqual([]);
    await handlers['local-sources:remove']({}, 7);
    expect(calls[0]).toMatchObject({ method: 'DELETE', url: 'http://nas:3030/api/local-sources/7' });
  });

  it('api key ids must be the 12-hex server id', async () => {
    const { handlers, calls } = setup();
    for (const bad of ['..', '../saves', 'ABCDEF012345', '0123456789abcdef', 12]) {
      expect(await handlers['api-keys:remove']({}, bad)).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    }
    expect(calls).toEqual([]);
    await handlers['api-keys:remove']({}, '0123456789ab');
    expect(calls[0]).toMatchObject({ method: 'DELETE', url: 'http://nas:3030/api/api-keys/0123456789ab' });
  });

  it('limits are integers 1..100 sent as a query param, or omitted', async () => {
    const { handlers, calls } = setup();
    for (const channel of ['playtime:recent', 'achievements:recent']) {
      for (const bad of ['10&admin=1', 0, 101, 2.5, '5']) {
        expect(await handlers[channel]({}, bad)).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
      }
    }
    expect(calls).toEqual([]);
    await handlers['playtime:recent']({}, 10);
    await handlers['achievements:recent']({}, undefined);
    expect(calls[0]).toMatchObject({ url: 'http://nas:3030/api/playtime/recent', params: { limit: 10 } });
    expect(calls[1].url).toBe('http://nas:3030/api/achievements/recent');
    expect(calls[1].params).toBeUndefined();
  });

  it('string ids and names are encoded as one segment; . and .. are refused', async () => {
    const { handlers, calls } = setup();
    await handlers['conflicts:resolve']({}, 'c?1', 'local');
    await handlers['achievements:get']({}, 'Half-Life 2: Ep/1');
    expect(calls.map((c) => c.url)).toEqual([
      'http://nas:3030/api/conflicts/c%3F1/resolve',
      'http://nas:3030/api/achievements/Half-Life%202%3A%20Ep%2F1',
    ]);
    for (const bad of ['.', '..', '']) expect(await handlers['conflicts:resolve']({}, bad, 'local')).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    expect(await handlers['conflicts:resolve']({}, 'c1', 'everything')).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    expect(calls).toHaveLength(2);
  });
});

describe('server code pass-through (DUN-121)', () => {
  it('403 and server codes reach the renderer unchanged', async () => {
    const { handlers } = setup(() => httpError(403, { error: 'Admin only', code: 'FORBIDDEN' }));
    expect(await handlers['remote-servers:get']({})).toEqual({ ok: false, status: 403, code: 'FORBIDDEN', message: 'Admin only' });
  });

  it('art routes pass PROVIDER_KEY_NOT_SET through', async () => {
    const { handlers } = setup(() => httpError(400, { error: 'SteamGridDB key not set', code: 'PROVIDER_KEY_NOT_SET' }));
    expect(await handlers['art:search']({}, 'Hades')).toEqual({ ok: false, status: 400, code: 'PROVIDER_KEY_NOT_SET', message: 'SteamGridDB key not set' });
    expect(await handlers['art:auto-match']({})).toMatchObject({ code: 'PROVIDER_KEY_NOT_SET' });
  });
});

describe('Ollama (DUN-095/057)', () => {
  it('never sends an endpoint from the renderer; OLLAMA_NOT_CONFIGURED passes through', async () => {
    const { handlers, calls } = setup(() => httpError(400, { error: 'No Ollama endpoint configured', code: 'OLLAMA_NOT_CONFIGURED' }));
    const res = await handlers['ollama:models']({}, 'http://169.254.169.254/');
    expect(res).toEqual({ ok: false, status: 400, code: 'OLLAMA_NOT_CONFIGURED', message: 'No Ollama endpoint configured' });
    expect(calls[0].url).toBe('http://nas:3030/api/ollama-models');
    expect(calls[0].params).toBeUndefined();
    await handlers['ollama:health']({}, 'http://evil');
    expect(calls[1].url).toBe('http://nas:3030/api/ollama-health');
    expect(calls[1].params).toBeUndefined();
  });
});

describe('SteamGridDB key (DUN-092, write-only)', () => {
  it('status/set/clear use the provider-key routes and return only { set }', async () => {
    const { handlers, calls } = setup((cfg) => ({ status: 200, data: { set: cfg.method !== 'DELETE', key: 'LEAK' } }));
    expect(await handlers['steamGridKey:status']({})).toEqual({ ok: true, set: true });
    expect(await handlers['steamGridKey:set']({}, '  abc  ')).toEqual({ ok: true, set: true });
    expect(await handlers['steamGridKey:clear']({})).toEqual({ ok: true, set: false });
    expect(calls.map((c) => [c.method, c.url, c.data])).toEqual([
      ['GET', 'http://nas:3030/api/provider-keys/steamgriddb', undefined],
      ['PUT', 'http://nas:3030/api/provider-keys/steamgriddb', { key: 'abc' }],
      ['DELETE', 'http://nas:3030/api/provider-keys/steamgriddb', undefined],
    ]);
  });

  it('an empty key is refused locally; 403 (non-admin) passes through', async () => {
    const { handlers, calls } = setup(() => httpError(403, { error: 'Admin only', code: 'FORBIDDEN' }));
    expect(await handlers['steamGridKey:set']({}, '   ')).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    expect(calls).toEqual([]);
    expect(await handlers['steamGridKey:set']({}, 'abc')).toEqual({ ok: false, status: 403, code: 'FORBIDDEN', message: 'Admin only' });
  });
});

describe('artwork opt-in (settings.artworkEnabled)', () => {
  it('art routes answer ARTWORK_DISABLED and send nothing while artwork is off', async () => {
    const { handlers, calls } = setup(undefined, false);
    expect(await handlers['art:search']({}, 'Hades')).toMatchObject({ ok: false, code: 'ARTWORK_DISABLED' });
    expect(await handlers['art:auto-match']({})).toMatchObject({ ok: false, code: 'ARTWORK_DISABLED' });
    expect(calls).toHaveLength(0);
  });
});

describe('save versions by game id (DUN-038)', () => {
  it('listVersions sends gameId; a name or bad id never reaches the server', async () => {
    const { handlers, calls } = setup();
    await handlers['saves:listVersions']({}, 7);
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'http://nas:3030/api/save-versions', params: { gameId: 7 } });
    expect(await handlers['saves:listVersions']({}, 'Hades')).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    expect(await handlers['saves:listVersions']({}, -1)).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    expect(calls).toHaveLength(1);
  });

  it('restore sends { gameId, versionId } only (DUN-137); a name or bad id never reaches the server', async () => {
    const { handlers, calls } = setup();
    await handlers['saves:restore']({}, 7, 'v1');
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'http://nas:3030/api/restore-version' });
    expect(calls[0].data).toEqual({ gameId: 7, versionId: 'v1' });
    expect(await handlers['saves:restore']({}, 'Hades', 'v1')).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    expect(await handlers['saves:restore']({}, 0, 'v1')).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    expect(await handlers['saves:restore']({}, 7, '')).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    expect(calls).toHaveLength(1);
  });
});
