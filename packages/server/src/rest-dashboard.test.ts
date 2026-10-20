import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';

// Isolate ALL side effects BEFORE importing the app module. Each test file gets
// its own module instance, so the in-memory rate limiter budget is fresh here —
// this file deliberately covers the dashboard/admin REST contract that the
// shared rest-shims file has no budget left for.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-restdash-test-'));
const SETUP_DATA_DIR = process.env.DATA_DIR as string; // temp dir from src/test/setup.ts (DUN-005)
process.env.DATA_DIR = TMP;
process.env.API_KEY_SECRET = 'restdash-secret-0123456789abcdef';

const { app } = await import('./server.js');
const { database } = await import('./db/index.js');

const AUTH_KEY = 'restdash-admin-key-0123456789';
database.addApiKey(AUTH_KEY);

const api = (req: request.Test) => req.set('x-api-key', AUTH_KEY);

const createMember = async (name: string) =>
  (await api(request(app).post('/api/users')).send({ name, role: 'member' })).body.apiKey as string;

const upload = (game: string, file = 's.sav', body = 'x') =>
  api(
    request(app)
      .post('/api/upload-file')
      .set('Content-Type', 'application/octet-stream')
      .set('x-game', game)
      .set('x-path', file)
      .set('x-sync-id', String(Date.now())),
  ).send(Buffer.from(body));

afterAll(() => {
  process.env.DATA_DIR = SETUP_DATA_DIR; // restore the temp dir, never unset (DUN-005)
  delete process.env.API_KEY_SECRET;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('GET /api/settings', () => {
  it('returns settings to admins with only a SteamGridDB set flag (DUN-092)', async () => {
    await api(request(app).post('/api/settings')).send({ maxVersions: 4 });
    const res = await api(request(app).get('/api/settings'));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.settings.maxVersions).toBe(4);
    expect(res.body.settings.steamGridApiKeySet).toBe(false);
    expect('steamGridApiKey' in res.body.settings).toBe(false);
    // API keys are never echoed in plaintext, even to admins.
    expect(res.body.settings.apiKeys.every((k: string) => k === '****')).toBe(true);
  });
});

describe('POST /api/settings', () => {
  it('is admin-only', async () => {
    const memberKey = await createMember('SettingsWriter');
    const forbidden = await request(app)
      .post('/api/settings')
      .set('x-api-key', memberKey)
      .send({ maxVersions: 9 });
    expect(forbidden.status).toBe(403);
  });

  it('ignores invalid values and persists valid ones', async () => {
    const res = await api(request(app).post('/api/settings')).send({ maxVersions: -5, ollamaModel: 'llama3:8b' });
    expect(res.body.success).toBe(true);
    const settings = (await api(request(app).get('/api/settings'))).body.settings;
    expect(settings.ollamaModel).toBe('llama3:8b');
    expect(settings.maxVersions).toBeGreaterThan(0); // negative ignored
  });

  it('rejects steamGridApiKey (write-only, own route) with 400 WRITE_ONLY_FIELD and stores nothing', async () => {
    const res = await api(request(app).post('/api/settings')).send({ steamGridApiKey: 'sgdb-via-settings-0123456789', maxVersions: 6 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.any(String), code: 'WRITE_ONLY_FIELD' });
    const settings = (await api(request(app).get('/api/settings'))).body.settings;
    expect(settings.steamGridApiKeySet).toBe(false);
    expect(settings.maxVersions).not.toBe(6);
  });
});

describe('DELETE /api/saves', () => {
  it('removes by id and by name, and validates input', async () => {
    await upload('DelById');
    await upload('DelByName');
    const games = (await api(request(app).get('/api/saves'))).body.games as Array<{ id: number; name: string }>;
    const target = games.find(g => g.name === 'DelById')!;

    expect((await api(request(app).delete('/api/saves'))).status).toBe(400);
    expect((await api(request(app).delete('/api/saves?id=notanumber'))).status).toBe(400);
    expect((await api(request(app).delete('/api/saves?id=999999'))).status).toBe(404);
    expect((await api(request(app).delete('/api/saves?game=GhostGame'))).status).toBe(404);

    expect((await api(request(app).delete(`/api/saves?id=${target.id}`))).body.success).toBe(true);
    expect((await api(request(app).delete('/api/saves?game=DelByName'))).body.success).toBe(true);
  });

  it('is admin-only', async () => {
    const memberKey = await createMember('SavesMember');
    const res = await request(app).delete('/api/saves?game=Whatever').set('x-api-key', memberKey);
    expect(res.status).toBe(403);
  });
});

describe('admin user-key management', () => {
  it("issues and revokes another user's keys", async () => {
    const created = await api(request(app).post('/api/users')).send({ name: 'KeyTarget' });
    const uid = created.body.user.id as string;

    expect((await api(request(app).post('/api/users/nope/keys')).send({})).status).toBe(404);
    const issued = await api(request(app).post(`/api/users/${uid}/keys`)).send({ description: 'ops' });
    expect(issued.status).toBe(201);
    expect(issued.body.apiKey).toMatch(/^dune_/);

    const keyHash = database.listUserKeys(uid)[0].hash as string;
    expect((await api(request(app).delete(`/api/users/${uid}/keys/nope`))).status).toBe(404);
    expect(
      (await api(request(app).delete(`/api/users/${uid}/keys/${keyHash.slice(0, 12)}`))).body.success,
    ).toBe(true);
  });

  it('refuses to delete the last admin', async () => {
    const admin = database.listUsers().find(u => u.role === 'admin')!;
    expect((await api(request(app).delete(`/api/users/${admin.id}`))).status).toBe(400);
  });
});

describe('dashboard assets', () => {
  it('references the app icon from the dashboard HTML', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<link rel="icon" type="image/png" href="/icon.png"');
  });

  it('serves the app icon at /icon.png (no auth required)', async () => {
    const res = await request(app).get('/icon.png');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\/png/);
  });
});
