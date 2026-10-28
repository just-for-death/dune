import { describe, it, expect, vi } from 'vitest';
import { createServerClient, type ServerHttp } from './serverClient';
import { createServerIpcHandlers } from './serverHandlers';

function setup(respond: (cfg: Record<string, unknown>) => unknown = () => ({ data: { success: true }, status: 200 }), artOn = true, baseUrl: string | null = 'http://nas:3030') {
  const calls: Record<string, unknown>[] = [];
  const http = {
    request: vi.fn(async (cfg: Record<string, unknown>) => {
      calls.push(cfg);
      const r = respond(cfg);
      if (r instanceof Error) throw r;
      return r;
    }),
  } as unknown as ServerHttp;
  const handlers = createServerIpcHandlers(createServerClient({ http, baseUrl: () => baseUrl, apiKey: () => 'k' }), { artworkEnabled: () => artOn });
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
    await handlers['achievements:detail']({}, 'Half-Life 2: Ep/1');
    expect(calls.map((c) => c.url)).toEqual([
      'http://nas:3030/api/conflicts/c%3F1/resolve',
      'http://nas:3030/api/achievements/detail/Half-Life%202%3A%20Ep%2F1',
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

  it('DUN-113: art:auto-match is a POST with no body; DUN-010: achievements:get is gone', async () => {
    const { handlers, calls } = setup();
    await handlers['art:auto-match']({});
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'http://nas:3030/api/auto-match-all' });
    expect(calls[0].data).toBeUndefined();
    expect(handlers['achievements:get']).toBeUndefined();
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

describe('artwork gating', () => {
  it('with a server, the server decides: no local pre-gate, its 403 PROVIDER_DISABLED passes through unchanged', async () => {
    const { handlers, calls } = setup(() => httpError(403, { error: 'Artwork is disabled on this server', code: 'PROVIDER_DISABLED' }), false);
    const disabled = { ok: false, status: 403, code: 'PROVIDER_DISABLED', message: 'Artwork is disabled on this server' };
    expect(await handlers['art:search']({}, 'Hades')).toEqual(disabled);
    expect(await handlers['art:auto-match']({})).toEqual(disabled);
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', 'http://nas:3030/api/search-art'],
      ['POST', 'http://nas:3030/api/auto-match-all'],
    ]);
  });

  it('with a server and the server flag on, art works even if the local flag is off', async () => {
    const { handlers, calls } = setup(() => ({ data: { success: true, results: ['x'] }, status: 200 }), false);
    expect(await handlers['art:search']({}, 'Hades')).toMatchObject({ ok: true, results: ['x'] });
    expect(calls).toHaveLength(1);
  });

  it('without a server, the local artworkEnabled gates: PROVIDER_DISABLED and nothing sent while off', async () => {
    const off = setup(undefined, false, null);
    expect(await off.handlers['art:search']({}, 'Hades')).toMatchObject({ ok: false, code: 'PROVIDER_DISABLED' });
    expect(await off.handlers['art:auto-match']({})).toMatchObject({ ok: false, code: 'PROVIDER_DISABLED' });
    expect(off.calls).toHaveLength(0);
    // On locally but still no server: the usual NO_SERVER.
    const on = setup(undefined, true, null);
    expect(await on.handlers['art:search']({}, 'Hades')).toMatchObject({ ok: false, code: 'NO_SERVER' });
    expect(on.calls).toHaveLength(0);
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

describe('current user (DUN-115)', () => {
  const me = (user: unknown) => () => ({ status: 200, data: { success: true, user } });

  it('GETs /api/users/me and returns exactly { ok, id, name, role }', async () => {
    const { handlers, calls } = setup(me({ id: 'u-1', name: 'Test User', role: 'member', apiKey: 'LEAK' }));
    expect(await handlers['users:me']({})).toEqual({ ok: true, id: 'u-1', name: 'Test User', role: 'member' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'http://nas:3030/api/users/me' });
    expect(calls[0].data).toBeUndefined();
    const admin = setup(me({ id: 'u-2', name: 'Admin', role: 'admin' }));
    expect(await admin.handlers['users:me']({})).toEqual({ ok: true, id: 'u-2', name: 'Admin', role: 'admin' });
  });

  it('401 and 403 pass through unchanged', async () => {
    const unauth = setup(() => httpError(401, { error: 'API key required', code: 'UNAUTHORIZED' }));
    expect(await unauth.handlers['users:me']({})).toEqual({ ok: false, status: 401, code: 'UNAUTHORIZED', message: 'API key required' });
    const forbidden = setup(() => httpError(403, { error: 'Invalid API key', code: 'INVALID_API_KEY' }));
    expect(await forbidden.handlers['users:me']({})).toEqual({ ok: false, status: 403, code: 'INVALID_API_KEY', message: 'Invalid API key' });
  });

  it('a bad role or malformed user is rejected, never passed on', async () => {
    for (const bad of [
      { id: 'u-1', name: 'X', role: 'superadmin' },
      { id: 'u-1', name: 'X', role: 'Admin' },
      { id: 'u-1', name: 'X' },
      { id: 'u-1', name: 'X', role: 1 },
      { id: 7, name: 'X', role: 'admin' },
      { id: 'u-1', role: 'admin' },
      null,
      'admin',
    ]) {
      const { handlers } = setup(me(bad));
      const res = await handlers['users:me']({});
      expect(res).toMatchObject({ ok: false, code: 'SERVER_ERROR' });
      expect(res).not.toHaveProperty('role');
    }
    const { handlers } = setup(() => ({ status: 200, data: { success: true } }));
    expect(await handlers['users:me']({})).toMatchObject({ ok: false, code: 'SERVER_ERROR' });
  });

  it('no response is NETWORK with no status', async () => {
    const { handlers } = setup(() => Object.assign(new Error('connect ECONNREFUSED'), { isAxiosError: true, request: {} }));
    const res = await handlers['users:me']({});
    expect(res).toMatchObject({ ok: false, code: 'NETWORK' });
    expect(res).not.toHaveProperty('status');
  });
});

describe('server provider flags (settings:providerFlags:*)', () => {
  const settings = { maxVersions: 5, ollamaEndpoint: 'http://x', apiKeys: ['****'], localSources: [], steamGridApiKeySet: true, hltbEnabled: true, artworkEnabled: false, manifestEnabled: true };
  const ok = (cfg: Record<string, unknown>) => (cfg.method === 'GET' ? { status: 200, data: { success: true, settings } } : { status: 200, data: { success: true } });

  it('get GETs /api/settings and returns only the three flags', async () => {
    const { handlers, calls } = setup(ok);
    expect(await handlers['settings:providerFlags:get']({})).toEqual({ ok: true, hltbEnabled: true, artworkEnabled: false, manifestEnabled: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'http://nas:3030/api/settings' });
    expect(calls[0].data).toBeUndefined();
  });

  it('get rejects a response with missing or non-boolean flags', async () => {
    for (const bad of [{ hltbEnabled: 'true', artworkEnabled: false, manifestEnabled: false }, { hltbEnabled: true }, { hltbEnabled: true, artworkEnabled: false }, { hltbEnabled: true, artworkEnabled: false, manifestEnabled: 'false' }, null]) {
      const { handlers } = setup(() => ({ status: 200, data: { success: true, settings: bad } }));
      const res = await handlers['settings:providerFlags:get']({});
      expect(res).toMatchObject({ ok: false, code: 'SERVER_ERROR' });
      expect(res).not.toHaveProperty('hltbEnabled');
    }
  });

  it('set POSTs only the patch to /api/settings, then reads the flags back', async () => {
    const { handlers, calls } = setup(ok);
    expect(await handlers['settings:providerFlags:set']({}, { hltbEnabled: true })).toEqual({ ok: true, hltbEnabled: true, artworkEnabled: false, manifestEnabled: true });
    expect(calls.map((c) => [c.method, c.url, c.data])).toEqual([
      ['POST', 'http://nas:3030/api/settings', { hltbEnabled: true }],
      ['GET', 'http://nas:3030/api/settings', undefined],
    ]);
    await handlers['settings:providerFlags:set']({}, { hltbEnabled: false, artworkEnabled: true });
    expect(calls[2].data).toEqual({ hltbEnabled: false, artworkEnabled: true });
    await handlers['settings:providerFlags:set']({}, { manifestEnabled: false });
    expect(calls[4]).toMatchObject({ method: 'POST', data: { manifestEnabled: false } });
  });

  it('invalid patches are refused locally and nothing is sent', async () => {
    const { handlers, calls } = setup(ok);
    for (const bad of [
      undefined, null, 'hltbEnabled', true, [], {},
      { hltbEnabled: 'true' }, { artworkEnabled: 1 }, { hltbEnabled: null }, { manifestEnabled: 'true' }, { manifestEnabled: true, updateCheckEnabled: true },
      { maxVersions: 3 }, { hltbEnabled: true, ollamaEndpoint: 'http://169.254.169.254/' }, { __proto__: { hltbEnabled: true } },
    ]) {
      expect(await handlers['settings:providerFlags:set']({}, bad)).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    }
    expect(calls).toEqual([]);
  });

  it('403 codes pass through unchanged and nothing is read back', async () => {
    for (const code of ['FORBIDDEN', 'PROVIDER_DISABLED']) {
      const { handlers, calls } = setup(() => httpError(403, { error: 'No', code }));
      expect(await handlers['settings:providerFlags:set']({}, { artworkEnabled: true })).toEqual({ ok: false, status: 403, code, message: 'No' });
      expect(calls).toHaveLength(1);
      expect(await handlers['settings:providerFlags:get']({})).toEqual({ ok: false, status: 403, code, message: 'No' });
    }
  });

  it('no response is NETWORK with no status', async () => {
    const { handlers } = setup(() => Object.assign(new Error('connect ECONNREFUSED'), { isAxiosError: true, request: {} }));
    for (const res of [await handlers['settings:providerFlags:get']({}), await handlers['settings:providerFlags:set']({}, { hltbEnabled: false })]) {
      expect(res).toMatchObject({ ok: false, code: 'NETWORK' });
      expect(res).not.toHaveProperty('status');
    }
  });
});
