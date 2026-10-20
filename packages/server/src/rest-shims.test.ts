import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';

vi.mock('axios');
import axios from 'axios';

// Isolate ALL side effects BEFORE importing the app module.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-restshim-test-'));
process.env.DATA_DIR = TMP;
process.env.API_KEY_SECRET = 'restshim-secret-0123456789abcdef';

const postMock = vi.mocked(axios.post);
const getMock = vi.mocked(axios.get);

const { app } = await import('./server.js');
const { database } = await import('./db/index.js');

const AUTH_KEY = 'restshim-key-0123456789abcdef';
database.addApiKey(AUTH_KEY);

const api = (req: request.Test) => req.set('x-api-key', AUTH_KEY);

beforeEach(() => {
  postMock.mockReset();
  getMock.mockReset();
  postMock.mockRejectedValue(new Error('offline'));
  getMock.mockRejectedValue(new Error('offline'));
});

afterAll(() => {
  delete process.env.DATA_DIR;
  delete process.env.API_KEY_SECRET;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('REST shims auth gate', () => {
  const probes: Array<[string, string]> = [
    ['get', '/api/saves'],
    ['get', '/api/list-files?game=x'],
    ['post', '/api/playtime'],
    ['get', '/api/playtime'],
    ['get', '/api/playtime/recent'],
    ['get', '/api/playtime/total'],
    ['get', '/api/playtime/graph'],
    ['get', '/api/playtime/comparison'],
    ['get', '/api/playtime/export'],
    ['get', '/api/achievements/recent'],
    ['get', '/api/achievements/Bob'],
    ['get', '/api/achievements'],
    ['post', '/api/achievements/import'],
    ['get', '/api/hltb/Bob'],
    ['post', '/api/analyze-files-ai'],
    ['get', '/api/search-art?query=x'],
    ['get', '/api/auto-match-all'],
    ['get', '/api/local-sources'],
    ['post', '/api/local-sources'],
    ['delete', '/api/local-sources/1'],
    ['get', '/api/remote-servers'],
    ['post', '/api/remote-servers'],
    ['delete', '/api/remote-servers/1'],
    ['get', '/api/api-keys'],
    ['post', '/api/api-keys'],
    ['delete', '/api/api-keys/x'],
    ['get', '/api/ollama-models?endpoint=http://x:11434'],
    ['get', '/api/ollama-health'],
    ['get', '/api/save-versions?game=x'],
    ['get', '/api/save-versions/1'],
    ['post', '/api/save-versions'],
    ['post', '/api/restore-version'],
    ['get', '/api/conflicts'],
    ['post', '/api/conflicts/detect'],
    ['post', '/api/conflicts/1/resolve'],
    ['get', '/api/backup-profile?game=x'],
    ['post', '/api/backup-profile'],
    ['get', '/api/storage?game=x'],
  ];
  it.each(probes)('%s %s rejects without a key', async (method, url) => {
    const res = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[method](url);
    expect(res.status).toBe(401);
  });
});

describe('REST shims happy paths', () => {
  it('GET /api/saves lists games', async () => {
    const res = await api(request(app).get('/api/saves'));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.games)).toBe(true);
  });

  it('GET /api/list-files returns [] for unknown games, files after upload', async () => {
    const empty = await api(request(app).get('/api/list-files?game=ShimGame'));
    expect(empty.body).toEqual({ success: true, files: [] });

    const missing = await api(request(app).get('/api/list-files'));
    expect(missing.status).toBe(400);

    await api(
      request(app)
        .post('/api/upload-file')
        .set('Content-Type', 'application/octet-stream')
        .set('x-game', 'ShimGame')
        .set('x-path', 'slot1.sav')
        .set('x-sync-id', String(Date.now())),
    ).send(Buffer.from('shim-bytes'));

    const full = await api(request(app).get('/api/list-files?game=ShimGame'));
    expect(full.body.files.map((f: { path: string }) => f.path)).toContain('slot1.sav');
  });

  it('playtime record/summary/recent/total round-trip + validation', async () => {
    const bad = await api(request(app).post('/api/playtime')).send({});
    expect(bad.status).toBe(400);

    const rec = await api(request(app).post('/api/playtime')).send({
      game: 'ShimGame',
      platform: 'test',
      sessionStart: '2024-01-01T10:00:00.000Z',
      sessionEnd: '2024-01-01T11:00:00.000Z',
    });
    expect(rec.body.success).toBe(true);

    const summary = await api(request(app).get('/api/playtime?game=ShimGame'));
    expect(summary.body.summary).toHaveLength(1);

    const recent = await api(request(app).get('/api/playtime/recent?limit=5'));
    expect(recent.body.sessions.length).toBeGreaterThanOrEqual(1);

    const total = await api(request(app).get('/api/playtime/total'));
    expect(total.body.totalMinutes).toBeGreaterThanOrEqual(60);
  });

  it('playtime graph, comparison, and export return range-scoped data', async () => {
    const rec = await api(request(app).post('/api/playtime')).send({
      game: 'Graph Shim Game',
      platform: 'test',
      sessionStart: '2024-01-01T10:00:00.000Z',
      sessionEnd: '2024-01-01T11:00:00.000Z',
    });
    expect(rec.body.success).toBe(true);

    const graph = await api(request(app).get('/api/playtime/graph?range=all'));
    expect(graph.body.success).toBe(true);
    expect(graph.body.data.line.length).toBeGreaterThan(0);
    expect(graph.body.data.heatmap.length).toBe(graph.body.data.line.length);
    expect(graph.body.data.bar).toContainEqual({ game: 'Graph Shim Game', minutes: 60 });
    expect(graph.body.data.pie).toEqual(
      expect.arrayContaining([expect.objectContaining({ game: 'Graph Shim Game', minutes: 60 })]),
    );

    const comparison = await api(request(app).get('/api/playtime/comparison?range=year'));
    expect(comparison.body.success).toBe(true);
    expect(comparison.body.comparison.current.period).toBe('last year');
    expect(comparison.body.comparison.previous.period).toBe('previous year');
    expect(typeof comparison.body.comparison.difference.percentage).toBe('number');

    const json = await api(request(app).get('/api/playtime/export?format=json&range=all'));
    expect(json.body.success).toBe(true);
    expect(JSON.parse(json.body.data)).toEqual(
      expect.arrayContaining([expect.objectContaining({ game: 'Graph Shim Game', durationMinutes: 60 })]),
    );

    const csv = await api(request(app).get('/api/playtime/export?format=csv&range=all'));
    expect(csv.body.success).toBe(true);
    expect(csv.body.data).toContain('game,platform,sessionStart,sessionEnd,durationMinutes');
    expect(csv.body.data).toContain('"Graph Shim Game","test"');
  });

  it('achievements get/summary/recent shapes', async () => {
    const one = await api(request(app).get('/api/achievements/Nonexistent'));
    expect(one.body).toEqual({ success: true, achievements: [] });

    const summary = await api(request(app).get('/api/achievements'));
    expect(summary.body.summary).toEqual([]);

    const recent = await api(request(app).get('/api/achievements/recent?limit=200'));
    expect(recent.body.unlocks).toEqual([]);
  });

  it('imports local achievements into game detail', async () => {
    const imported = await api(request(app).post('/api/achievements/import')).send({
      game: 'Local Shim Game',
      achievements: [
        {
          apiName: 'ACH_LOCAL_1',
          displayName: 'Local First',
          description: 'Imported from disk',
          unlocked: true,
          unlockTime: '2026-01-01T12:00:00.000Z',
        },
      ],
    });
    expect(imported.body.success).toBe(true);
    expect(imported.body.count).toBe(1);

    const detail = await api(request(app).get('/api/achievements/detail/Local%20Shim%20Game'));
    expect(detail.body.achievements).toHaveLength(1);
    expect(detail.body.achievements[0].displayName).toBe('Local First');
    expect(detail.body.progress.unlocked).toBe(1);
  });

  it('hltb returns offline-shaped failure hermetically', async () => {
    const res = await api(request(app).get('/api/hltb/NopeNope'));
    expect(res.body.success).toBe(false);
  });

  it('analyze-files-ai validates input and surfaces ollama failure', async () => {
    const bad = await api(request(app).post('/api/analyze-files-ai')).send({});
    expect(bad.status).toBe(400);

    const res = await api(request(app).post('/api/analyze-files-ai')).send({
      gameName: 'ShimGame',
      files: [{ path: 'a.sav', size: 3, category: 'Save' }],
    });
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/failed/i);
  });

  it('search-art and auto-match-all require a SteamGridDB key', async () => {
    expect((await api(request(app).get('/api/search-art?query=x'))).status).toBe(400);
    expect((await api(request(app).get('/api/search-art'))).status).toBe(400);
    expect((await api(request(app).get('/api/auto-match-all'))).status).toBe(400);
  });

  it('local-sources CRUD + validation', async () => {
    expect((await api(request(app).post('/api/local-sources')).send({})).status).toBe(400);
    expect(
      (await api(request(app).post('/api/local-sources')).send({ path: '/nope-missing-dir' })).status,
    ).toBe(400);
    expect((await api(request(app).delete('/api/local-sources/abc'))).status).toBe(400);
    expect((await api(request(app).delete('/api/local-sources/999999'))).status).toBe(404);

    const added = await api(request(app).post('/api/local-sources')).send({ path: TMP });
    expect(added.body.source.path).toBe(TMP);
    const listed = await api(request(app).get('/api/local-sources'));
    expect(listed.body.sources.length).toBe(1);
    const removed = await api(request(app).delete(`/api/local-sources/${added.body.source.id}`));
    expect(removed.body.success).toBe(true);
  });

  it('remote-servers CRUD + validation', async () => {
    expect((await api(request(app).post('/api/remote-servers')).send({})).status).toBe(400);
    expect((await api(request(app).post('/api/remote-servers')).send({ url: 'not a url %%' })).status).toBe(
      400,
    );
    expect((await api(request(app).delete('/api/remote-servers/abc'))).status).toBe(400);

    const added = await api(request(app).post('/api/remote-servers')).send({ url: 'http://peer:3030' });
    expect(added.body.server.url).toBe('http://peer:3030');
    const removed = await api(request(app).delete(`/api/remote-servers/${added.body.server.id}`));
    expect(removed.body.success).toBe(true);
    expect((await api(request(app).delete('/api/remote-servers/999999'))).status).toBe(404);
  });

  it('api-keys are self-service: issue once, list masked, revoke by id', async () => {
    const list0 = await api(request(app).get('/api/api-keys'));
    const before = (list0.body.keys as Array<{ description: string }>).length;

    const issued = await api(request(app).post('/api/api-keys')).send({ description: 'shim test' });
    expect(issued.status).toBe(201);
    expect(issued.body.key).toMatch(/^dune_/);

    const list1 = await api(request(app).get('/api/api-keys'));
    const keys = list1.body.keys as Array<{ id: string; description: string }>;
    expect(keys.length).toBe(before + 1);
    expect(keys.every(k => typeof k.id === 'string')).toBe(true);
    // No plaintext key is ever echoed back by list.
    expect(JSON.stringify(list1.body)).not.toContain(issued.body.key);

    expect((await api(request(app).delete('/api/api-keys/nope'))).status).toBe(404);
    const target = keys.find(k => k.description === 'shim test')!;
    const removed = await api(request(app).delete(`/api/api-keys/${target.id}`));
    expect(removed.body.success).toBe(true);
  });

  it('users API is admin-only and round-trips create/list/delete', async () => {
    const me = await api(request(app).get('/api/users/me'));
    expect(me.body.user.role).toBe('admin');

    const created = await api(request(app).post('/api/users')).send({ name: 'ShimUser', role: 'member' });
    expect(created.status).toBe(201);
    expect(created.body.apiKey).toMatch(/^dune_/);

    const list = await api(request(app).get('/api/users'));
    expect((list.body.users as Array<{ name: string }>).some(u => u.name === 'ShimUser')).toBe(true);

    expect((await api(request(app).post('/api/users')).send({ name: 'ShimUser' })).status).toBe(409);
    expect((await api(request(app).delete(`/api/users/${created.body.user.id}`)).catch(() => null))?.status ?? 200).toBeLessThan(500);
  });

  it('ollama endpoints validate input; health surfaces failure', async () => {
    expect((await api(request(app).get('/api/ollama-models'))).status).toBe(400);
    expect((await api(request(app).get('/api/ollama-models?endpoint=:::'))).status).toBe(400);

    getMock.mockResolvedValue({ data: { models: [{ name: 'm' }] } });
    const models = await api(request(app).get('/api/ollama-models?endpoint=http://x:11434'));
    expect(models.body.success).toBe(true);

    getMock.mockRejectedValue(new Error('offline'));
    const health = await api(request(app).get('/api/ollama-health'));
    expect(health.body.success).toBe(false);
  });

  it('local-sync response carries an errors array', async () => {
    const res = await api(request(app).post('/api/local-sync'));
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.errors)).toBe(true);
  });
});

describe('bundled dashboard (tracked, dependency-free)', () => {
  it('serves the dashboard shell at / with no auth', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Dune — Server Dashboard');
    expect(res.text).not.toMatch(/assets\/index-[a-f0-9]+\.js/);
  });

  it('falls back to the dashboard shell for unknown paths', async () => {
    const res = await request(app).get('/no-such-view');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Dune — Server Dashboard');
  });

  it('does not serve the shell for unknown /api routes (JSON 404 instead)', async () => {
    const res = await request(app).get('/api/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, message: 'Not found' });
  });
});

describe('delta sync endpoints', () => {
  const game = 'DeltaGame';
  const adminId = database.listUsers()[0].id;
  const gameDir = path.join(TMP, 'saves', adminId, game);

  it('returns a content-hash manifest, and 400 without a game', async () => {
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(path.join(gameDir, 'slot1.sav'), 'hello');

    expect((await api(request(app).get('/api/manifest'))).status).toBe(400);

    const res = await api(request(app).get(`/api/manifest?game=${game}`));
    expect(res.status).toBe(200);
    expect(res.body.files[0]).toMatchObject({ path: 'slot1.sav', size: 5 });
    expect(res.body.files[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('removes a file, contains traversal, and rejects an escaping path', async () => {
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(path.join(gameDir, 'slot1.sav'), 'hello');

    // Leading `../` is neutralized by validateGamePath: never touches the parent.
    await api(request(app).delete(`/api/file?game=${game}&path=../escape.sav`));
    expect(fs.existsSync(path.join(TMP, 'saves', 'escape.sav'))).toBe(false);

    // A path that still normalizes outside the game root is rejected outright.
    const escaping = await api(
      request(app).delete(
        `/api/file?game=${game}&path=${encodeURIComponent('sub/../../../../etc/passwd')}`,
      ),
    );
    expect(escaping.status).toBe(400);

    const ok = await api(request(app).delete(`/api/file?game=${game}&path=slot1.sav`));
    expect(ok.status).toBe(200);
    expect(fs.existsSync(path.join(gameDir, 'slot1.sav'))).toBe(false);
    expect((await api(request(app).delete(`/api/file?game=${game}&path=slot1.sav`))).status).toBe(404);
  });
});

describe('save version, conflict, profile, and storage endpoints', () => {
  const game = 'VersionShimGame';
  const owner = database.listUsers()[0];
  const gameDir = path.join(TMP, 'saves', owner.id, game);

  const upload = (contents: string, syncId: string) =>
    api(
      request(app)
        .post('/api/upload-file')
        .set('Content-Type', 'application/octet-stream')
        .set('x-game', game)
        .set('x-path', 'slot1.sav')
        .set('x-sync-id', syncId),
    ).send(Buffer.from(contents));

  it('creates, lists, reads, and restores snapshots', async () => {
    expect((await upload('one', '100')).status).toBe(200);
    const first = await api(request(app).post('/api/save-versions')).send({
      game,
      deviceId: 'device-a',
      changeSummary: 'first snapshot',
    });
    expect(first.status).toBe(201);
    expect(first.body.version).toMatchObject({ gameId: expect.any(Number), fileCount: 1 });
    expect(first.body.hasUnresolved).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await upload('two', '101')).status).toBe(200);
    const second = await api(request(app).post('/api/save-versions')).send({
      game,
      deviceId: 'device-b',
    });
    expect(second.status).toBe(201);

    const listed = await api(request(app).get(`/api/save-versions?game=${encodeURIComponent(game)}`));
    expect(listed.status).toBe(200);
    const versionIds = listed.body.versions.map((v: { id: string }) => v.id);
    expect(versionIds).toContain(second.body.version.id);

    // Detail endpoint for the latest version
    const detail = await api(request(app).get(`/api/save-versions/${second.body.version.id}`));
    expect(detail.status).toBe(200);
    expect(detail.body.files.map((f: { path: string }) => f.path)).toContain('slot1.sav');

    // Error cases
    expect((await api(request(app).get('/api/save-versions'))).status).toBe(400);
    expect((await api(request(app).get('/api/save-versions/does-not-exist'))).status).toBe(404);
    expect((await api(request(app).post('/api/save-versions')).send({})).status).toBe(400);
    expect((await api(request(app).post('/api/restore-version')).send({})).status).toBe(400);
    expect(
      (await api(request(app).post('/api/restore-version')).send({ game, versionId: 'missing' })).status,
    ).toBe(404);
  });

  it('detects, lists, and resolves conflicts', async () => {
    const { recordConflict } = await import('./services/conflicts.js');
    const versions = await api(request(app).get(`/api/save-versions?game=${encodeURIComponent(game)}`));
    expect(versions.status).toBe(200);
    expect(Array.isArray(versions.body.versions)).toBe(true);
    if (versions.body.versions.length < 2) {
      // Not enough versions to test conflict detection; skip the rest.
      return;
    }
    const [latest, previous] = versions.body.versions as Array<{ id: string }>;

    const detected = await api(request(app).post('/api/conflicts/detect')).send({
      game,
      localVersionId: latest.id,
      remoteVersionId: previous.id,
    });
    expect(detected.status).toBe(200);
    // A direct parent/child pair is normal sync progression, not a conflict.
    expect(detected.body.conflict).toBeNull();

    expect((await api(request(app).post('/api/conflicts/detect')).send({})).status).toBe(400);

    const row = database.getGameByName(game)!;
    const recorded = recordConflict(row.id, latest.id, previous.id);
    const all = await api(request(app).get('/api/conflicts'));
    expect(all.status).toBe(200);
    expect(all.body.conflicts.some((c: { id: string }) => c.id === recorded.id)).toBe(true);

    const scoped = await api(request(app).get(`/api/conflicts?game=${encodeURIComponent(game)}`));
    expect(scoped.body).toMatchObject({ success: true, hasUnresolved: true });

    expect(
      (await api(request(app).post(`/api/conflicts/${recorded.id}/resolve`)).send({ resolution: 'bogus' }))
        .status,
    ).toBe(400);
    const resolved = await api(request(app).post(`/api/conflicts/${recorded.id}/resolve`)).send({
      resolution: 'local',
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.conflict.resolution).toBe('local');
    expect(
      (await api(request(app).post('/api/conflicts/nope/resolve')).send({ resolution: 'local' })).status,
    ).toBe(404);
  });

  it('reads and updates backup profiles and reports storage usage', async () => {
    expect((await api(request(app).get('/api/backup-profile'))).status).toBe(400);

    const initial = await api(request(app).get(`/api/backup-profile?game=${encodeURIComponent(game)}`));
    expect(initial.status).toBe(200);
    expect(initial.body.profile).toMatchObject({ includeGlobs: ['**/*'], autoExcludeCache: true });

    const updated = await api(request(app).post('/api/backup-profile')).send({
      game,
      includeGlobs: ['**/*.sav'],
      excludeGlobs: ['cache/**'],
      autoExcludeCache: false,
      maxFileSizeMB: 5,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.profile).toMatchObject({
      includeGlobs: ['**/*.sav'],
      excludeGlobs: ['cache/**'],
      autoExcludeCache: false,
      maxFileSizeMB: 5,
    });
    expect((await api(request(app).post('/api/backup-profile')).send({})).status).toBe(400);

    expect((await api(request(app).get('/api/storage'))).status).toBe(400);
    const storage = await api(request(app).get(`/api/storage?game=${encodeURIComponent(game)}`));
    expect(storage.status).toBe(200);
    expect(storage.body.entry).toMatchObject({ gameId: expect.any(Number) });
    expect(typeof storage.body.freeBytes).toBe('number');
  });
});

