/**
 * DUN-092 (security-critical): the SteamGridDB key is encrypted at rest,
 * write-only, never returned (not even to admins) and never logged.
 */
import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
import { Writable } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-provider-keys-test-'));
const SETUP_DATA_DIR = process.env.DATA_DIR as string;
process.env.DATA_DIR = TMP;
process.env.API_KEY_SECRET = 'provider-keys-secret-0123456789abcdef';
process.env.LOG_LEVEL = 'debug';

// Capture every log line the server emits (real serializers/redaction).
const logs = vi.hoisted(() => ({ text: '' }));
vi.mock('./middleware/logging.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./middleware/logging.js')>();
  const sink = new Writable({ write(chunk, _enc, cb) { logs.text += chunk.toString(); cb(); } });
  return { ...real, logger: real.createLogger(sink) };
});
vi.mock('axios', async (importOriginal) => {
  const real = await importOriginal<typeof import('axios')>();
  const get = vi.fn();
  return { ...real, default: { ...real.default, get, post: vi.fn() } };
});

const axios = (await import('axios')).default;
const getMock = vi.mocked(axios.get);
const { app } = await import('./server.js');
const { database } = await import('./db/index.js');
const { closeDbForTests } = await import('./db/sqlite.js');

const ADMIN_KEY = 'provkeys-admin-key-0123456789';
database.addApiKey(ADMIN_KEY);
const admin = (r: request.Test) => r.set('x-api-key', ADMIN_KEY);
const KEY = 'sgdbSECRET0123456789abcdefFEDCBA';
const ROUTE = '/api/provider-keys/steamgriddb';

afterAll(() => {
  closeDbForTests();
  process.env.DATA_DIR = SETUP_DATA_DIR;
  delete process.env.API_KEY_SECRET;
  delete process.env.LOG_LEVEL;
  fs.rmSync(TMP, { recursive: true, force: true });
});
beforeEach(() => { getMock.mockReset(); });

/** Every byte the server persisted under DATA_DIR (DB + journal + anything else). */
function allPersistedBytes(): string {
  let out = '';
  for (const f of fs.readdirSync(TMP, { recursive: true, encoding: 'utf-8' })) {
    const abs = path.join(TMP, f);
    if (fs.statSync(abs).isFile()) out += fs.readFileSync(abs).toString('latin1');
  }
  return out;
}

describe('SteamGridDB key (DUN-092)', () => {
  it('set → status only; never in any response, the DB bytes or the logs; used as Bearer server-side', async () => {
    const memberKey = (await admin(request(app).post('/api/users')).send({ name: 'PK Member', role: 'member' })).body.apiKey as string;
    const member = (r: request.Test) => r.set('x-api-key', memberKey);

    expect((await admin(request(app).get(ROUTE))).body).toEqual({ set: false });
    const put = await admin(request(app).put(ROUTE)).send({ key: KEY });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ set: true });

    const responses: string[] = [JSON.stringify(put.body)];
    for (const who of [admin, member]) {
      const st = await who(request(app).get(ROUTE));
      expect(st.body).toEqual({ set: true });
      const settings = await who(request(app).get('/api/settings'));
      expect(settings.body.settings.steamGridApiKeySet).toBe(true);
      responses.push(JSON.stringify(st.body), JSON.stringify(settings.body));
    }

    // Server-side use: the provider client receives the key as a Bearer token.
    getMock.mockImplementation(async (url: string) => {
      if (String(url).includes('autocomplete')) throw new Error(`upstream 401 for token ${KEY}`);
      return { data: { success: false } };
    });
    const art = await admin(request(app).get('/api/search-art').query({ query: 'Hades' }));
    responses.push(JSON.stringify(art.body));
    expect(getMock.mock.calls[0][1]).toMatchObject({ headers: { Authorization: `Bearer ${KEY}` } });

    for (const body of responses) expect(body).not.toContain(KEY);
    expect(allPersistedBytes()).not.toContain(KEY);
    expect(logs.text).toContain('Provider key set');      // the sink really captures
    expect(logs.text).toContain('SteamGridDB search failed');
    expect(logs.text).not.toContain(KEY);

    // Raw kv row is an AES-GCM envelope, not the key.
    const { getDb } = await import('./db/sqlite.js');
    const row = getDb().prepare('SELECT value FROM kv WHERE key = ?').get('provider:steamgriddb') as { value: string };
    const env = JSON.parse(row.value) as Record<string, string>;
    expect(Object.keys(env).sort()).toEqual(['ct', 'iv', 'tag', 'v']);
    expect(Buffer.from(env.ct, 'base64').toString('latin1')).not.toContain(KEY);
    expect(allPersistedBytes()).not.toContain(Buffer.from(KEY).toString('base64').slice(0, 24));
  });

  it('members cannot set or clear (403); invalid input is 400 without echo', async () => {
    const memberKey = (await admin(request(app).post('/api/users')).send({ name: 'PK Member 2', role: 'member' })).body.apiKey as string;
    expect((await request(app).put(ROUTE).set('x-api-key', memberKey).send({ key: KEY })).status).toBe(403);
    expect((await request(app).delete(ROUTE).set('x-api-key', memberKey)).status).toBe(403);
    expect((await request(app).get(ROUTE)).status).toBe(401);
    const bad = await admin(request(app).put(ROUTE)).send({ key: 'bad key with spaces <script>' });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: expect.any(String), code: 'INVALID_PROVIDER_KEY' });
    expect(JSON.stringify(bad.body)).not.toContain('<script>');
  });

  it('clear → set:false and art routes answer 400 PROVIDER_KEY_NOT_SET', async () => {
    await admin(request(app).put(ROUTE)).send({ key: KEY });
    expect((await admin(request(app).delete(ROUTE))).body).toEqual({ set: false });
    expect((await admin(request(app).get(ROUTE))).body).toEqual({ set: false });
    const art = await admin(request(app).get('/api/search-art').query({ query: 'x' }));
    expect(art.status).toBe(400);
    expect(art.body).toEqual({ error: 'SteamGridDB API key not configured', code: 'PROVIDER_KEY_NOT_SET' });
    expect(getMock).not.toHaveBeenCalled();
  });

  it('a ciphertext written under another server secret is treated as unset, not leaked', async () => {
    await admin(request(app).put(ROUTE)).send({ key: KEY });
    const { withSteamGridKey } = await import('./services/providerKeys.js');
    const old = process.env.API_KEY_SECRET;
    process.env.API_KEY_SECRET = 'a-different-secret-0123456789abcdef';
    const used = vi.fn(async (k: string) => k);
    try {
      await expect(withSteamGridKey(used)).rejects.toMatchObject({ status: 400, code: 'PROVIDER_KEY_NOT_SET' });
    } finally {
      process.env.API_KEY_SECRET = old;
    }
    expect(used).not.toHaveBeenCalled();
    expect(logs.text).toContain('could not be decrypted');
    expect(logs.text).not.toContain(KEY);
    await expect(withSteamGridKey(used)).resolves.toBe(KEY); // original secret decrypts again
  });
});
