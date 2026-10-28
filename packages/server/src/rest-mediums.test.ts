// DUN-010/043/057/094-098/100-104: HTTP-level regression tests for the
// server mediums batch. Each describe names its issue.
import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';

vi.mock('axios');
import axios from 'axios';

// Isolate ALL side effects BEFORE importing the app module.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-mediums-test-'));
const SETUP_DATA_DIR = process.env.DATA_DIR as string; // temp dir from src/test/setup.ts (DUN-005)
process.env.DATA_DIR = TMP;
process.env.API_KEY_SECRET = 'mediums-secret-0123456789abcdef';
// DUN-102: a tight auth-failure budget for this file only (fresh module graph).
process.env.AUTH_FAIL_MAX = '5';

const postMock = vi.mocked(axios.post);
const getMock = vi.mocked(axios.get);

const { app } = await import('./server.js');
const { database, runBootMigrations } = await import('./db/index.js');
const { getDb } = await import('./db/sqlite.js');
const { getGameRoot } = await import('./utils/path.js');
const { authFailureLimiter, createAuthFailureLimiter, trustProxySetting } = await import('./middleware/security.js');
const { handleLocalSync } = await import('./services/sync.js');
const { triggerRemoteSync } = await import('./services/remoteSync.js');
const { createSaveVersion, getSaveVersion, listVersionRecords, createVersionFromDirectory } = await import('./services/saveVersions.js');
const { recordConflict } = await import('./services/conflicts.js');

// DUN-110: database.addApiKey (test-only) is gone; issue a real admin key.
const KEY = database.issueUserKey(database.listUsers().find((u) => u.role === 'admin')!.id, 'test admin key');
const ADMIN = database.listUsers().find((u) => u.role === 'admin')!.id;
const member = database.createUser(`mediums-member-${Date.now()}`, 'member');
const MEMBER_KEY = database.issueUserKey(member.id, 'member');

const api = (req: request.Test, key = KEY) => req.set('x-api-key', key);

function upload(game: string, rel: string, body: string | Buffer, syncId?: string, key = KEY): request.Test {
  let r = request(app)
    .post('/api/upload-file')
    .set('x-api-key', key)
    .set('Content-Type', 'application/octet-stream')
    .set('x-game', encodeURIComponent(game))
    .set('x-path', encodeURIComponent(rel));
  if (syncId !== undefined) r = r.set('x-sync-id', syncId);
  return r.send(typeof body === 'string' ? Buffer.from(body) : body);
}

const gameRow = (title: string, owner = ADMIN) => database.findGame(owner, title)!;

beforeEach(() => {
  postMock.mockReset();
  getMock.mockReset();
  postMock.mockRejectedValue(new Error('offline'));
  getMock.mockRejectedValue(new Error('offline'));
  authFailureLimiter.reset();
});

afterAll(() => {
  process.env.DATA_DIR = SETUP_DATA_DIR; // restore the temp dir, never unset (DUN-005)
  delete process.env.API_KEY_SECRET;
  delete process.env.AUTH_FAIL_MAX;
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── DUN-094 / DUN-010 ────────────────────────────────────────────────────────
describe('DUN-094/010: static routes are never shadowed by params', () => {
  it('GET /api/save-versions/diff answers 200 with the diff', async () => {
    expect((await upload('Diff Game', 'a.sav', 'one')).status).toBe(200);
    const v1 = await api(request(app).post('/api/save-versions')).send({ gameId: gameRow('Diff Game').id });
    expect((await upload('Diff Game', 'b.sav', 'two')).status).toBe(200);
    const v2 = await api(request(app).post('/api/save-versions')).send({ gameId: gameRow('Diff Game').id });
    const res = await api(request(app).get(`/api/save-versions/diff?from=${v1.body.version.id}&to=${v2.body.version.id}`));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, diff: { added: ['b.sav'], removed: [], changed: [], unchanged: 1 } });
    // Still a 400/404 contract, not the /:id handler.
    expect((await api(request(app).get('/api/save-versions/diff'))).body.code).toBe('BAD_REQUEST');
  });

  it('every static route is reached before any param route of the same method', () => {
    type Layer = { route?: { path: string | string[]; methods: Record<string, boolean> }; match: (p: string) => boolean };
    const stack = (app as unknown as { router: { stack: Layer[] } }).router.stack.filter((l) => l.route);
    const routes = stack.flatMap((l) => (Array.isArray(l.route!.path) ? l.route!.path : [l.route!.path]).map((p) => ({ l, p })));
    const shadowed: string[] = [];
    for (const { l, p } of routes) {
      if (/[:*{]/.test(p)) continue;
      for (const method of Object.keys(l.route!.methods)) {
        const first = stack.find((other) => other.route!.methods[method] && other.match(p));
        if (first !== l) shadowed.push(`${method.toUpperCase()} ${p} -> ${String(first?.route?.path)}`);
      }
    }
    expect(shadowed).toEqual([]);
  });
});

// ── DUN-057 / DUN-095 ────────────────────────────────────────────────────────
describe('DUN-057/095: Ollama off until configured; stored endpoint only', () => {
  it('a fresh install has no endpoint and every Ollama route is 400 OLLAMA_NOT_CONFIGURED', async () => {
    expect(database.getSettings().ollamaEndpoint).toBe('');
    for (const req of [
      api(request(app).get('/api/ollama-models')),
      api(request(app).get('/api/ollama-health')),
      api(request(app).post('/api/analyze-files-ai')).send({ gameName: 'G', files: [{ path: 'a.sav', size: 1, category: 'Save' }] }),
    ]) {
      const res = await req;
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.any(String), code: 'OLLAMA_NOT_CONFIGURED' });
    }
    expect(getMock).not.toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('GET /api/ollama-models is admin-only and refuses a caller-supplied endpoint', async () => {
    const asMember = await api(request(app).get('/api/ollama-models'), MEMBER_KEY);
    expect(asMember.status).toBe(403);
    expect(asMember.body.code).toBe('FORBIDDEN');
    const ssrf = await api(request(app).get('/api/ollama-models?endpoint=http://169.254.169.254'));
    expect(ssrf.status).toBe(400);
    expect(ssrf.body).toEqual({ error: expect.any(String), code: 'ENDPOINT_NOT_ALLOWED' });
    expect(getMock).not.toHaveBeenCalled();
  });

  it('upstream errors are generic (never echoed); "" turns Ollama back off', async () => {
    expect((await api(request(app).post('/api/settings')).send({ ollamaEndpoint: 'http://ollama.test:11434' })).status).toBe(200);
    getMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND internal-host.corp secret=abc'));
    const models = await api(request(app).get('/api/ollama-models'));
    expect(models.body).toEqual({ success: false, message: 'Failed to fetch models' });
    const health = await api(request(app).get('/api/ollama-health'));
    expect(health.body).toEqual({ success: false, message: 'Failed to check Ollama' });
    expect(getMock.mock.calls.every(([u]) => String(u).startsWith('http://ollama.test:11434/'))).toBe(true);

    expect((await api(request(app).post('/api/settings')).send({ ollamaEndpoint: '' })).status).toBe(200);
    expect(database.getSettings().ollamaEndpoint).toBe('');
    expect((await api(request(app).get('/api/ollama-health'))).body.code).toBe('OLLAMA_NOT_CONFIGURED');
  });

  it('boot migration clears the old implicit http://ollama:11434 default only', () => {
    database.saveSettings({ ...database.getSettings(), ollamaEndpoint: 'http://ollama:11434' });
    runBootMigrations();
    expect(database.getSettings().ollamaEndpoint).toBe('');
    database.saveSettings({ ...database.getSettings(), ollamaEndpoint: 'http://my-ollama:11434' });
    runBootMigrations();
    expect(database.getSettings().ollamaEndpoint).toBe('http://my-ollama:11434');
    database.saveSettings({ ...database.getSettings(), ollamaEndpoint: '' });
  });
});

// ── DUN-104 ──────────────────────────────────────────────────────────────────
describe('DUN-104: AI input and output are validated', () => {
  it('a non-string gameName / bad files are 400 INVALID_AI_INPUT, never 500', async () => {
    for (const body of [
      { gameName: 42, files: [{ path: 'a', size: 1, category: 'Save' }] },
      { gameName: { $gt: '' }, files: [] },
      { gameName: 'G', files: 'nope' },
      { gameName: 'G', files: [{ path: 'a', size: -1, category: 'Save' }] },
      { gameName: 'G', files: Array.from({ length: 501 }, (_, i) => ({ path: `f${i}`, size: 1, category: 'Save' })) },
    ]) {
      const res = await api(request(app).post('/api/analyze-files-ai')).send(body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.any(String), code: 'INVALID_AI_INPUT' });
    }
  });

  it('stores only validated, clamped entries for files that were asked about', async () => {
    await api(request(app).post('/api/settings')).send({ ollamaEndpoint: 'http://ollama.test:11434' });
    expect((await upload('AI Game', 'a.sav', 'x')).status).toBe(200);
    postMock.mockResolvedValue({
      data: {
        response: `Sure! ${JSON.stringify({
          'a.sav': { category: 'save', description: 'd'.repeat(5000), extra: 'dropped' },
          'b.cfg': { category: 'Weird', description: 'cfg' },
          'not-asked.bin': { category: 'Cache', description: 'injected' },
          'c.dat': 'not an object',
        })}`,
      },
    });
    const res = await api(request(app).post('/api/analyze-files-ai')).send({
      gameName: 'AI Game',
      files: [{ path: 'a.sav', size: 1, category: 'Save' }, { path: 'b.cfg', size: 1, category: 'Config' }, { path: 'c.dat', size: 1, category: 'Other' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const stored = gameRow('AI Game').analysis!;
    expect(Object.keys(stored).sort()).toEqual(['a.sav', 'b.cfg']);
    expect(stored['a.sav']).toEqual({ category: 'Save', description: 'd'.repeat(500) });
    expect(stored['b.cfg']).toEqual({ category: 'Other', description: 'cfg' });

    postMock.mockResolvedValue({ data: { response: 'no json here' } });
    const junk = await api(request(app).post('/api/analyze-files-ai')).send({ gameName: 'AI Game', files: [{ path: 'a.sav', size: 1, category: 'Save' }] });
    expect(junk.body).toEqual({ success: false, message: 'Failed to parse AI response' });
    expect(gameRow('AI Game').analysis).toEqual(stored); // unchanged
    await api(request(app).post('/api/settings')).send({ ollamaEndpoint: '' });
  });
});

// ── DUN-096 ──────────────────────────────────────────────────────────────────
describe('DUN-096: playtime ranges and sessions are bounded', () => {
  it('the 1000-01-01..9999-12-31 custom range is 400 INVALID_RANGE (was a 368 MB body)', async () => {
    const res = await api(request(app).get('/api/playtime/graph?range=custom&start=1000-01-01&end=9999-12-31'));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.any(String), code: 'INVALID_RANGE' });
    expect(JSON.stringify(res.body).length).toBeLessThan(500);
  });

  it.each([
    'range=custom',
    'range=custom&start=2024-01-01',
    'range=custom&start=2024-02-30&end=2024-03-01',
    'range=custom&start=2024-03-01&end=2024-01-01',
    'range=custom&start=2023-01-01&end=2024-01-03',
    'range=decade',
    'range=custom&start=yesterday&end=today',
  ])('graph %s -> 400 INVALID_RANGE', async (qs) => {
    const res = await api(request(app).get(`/api/playtime/graph?${qs}`));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_RANGE');
  });

  it('export and comparison validate too', async () => {
    expect((await api(request(app).get('/api/playtime/export?range=custom&start=1000-01-01&end=9999-12-31'))).body.code).toBe('INVALID_RANGE');
    expect((await api(request(app).get('/api/playtime/export?format=xml'))).status).toBe(400);
    expect((await api(request(app).get('/api/playtime/comparison?range=century'))).body.code).toBe('INVALID_RANGE');
    expect((await api(request(app).get('/api/playtime/comparison?range=month'))).status).toBe(200);
  });

  it('a 366-day custom range is answered with at most 367 daily buckets', async () => {
    const res = await api(request(app).get('/api/playtime/graph?range=custom&start=2024-01-01&end=2024-12-31'));
    expect(res.status).toBe(200);
    expect(res.body.data.bucket).toBe('day');
    expect(res.body.data.line).toHaveLength(366);
    expect(res.body.data.line[0].date).toBe('2024-01-01');
    expect(res.body.data.line.at(-1).date).toBe('2024-12-31');
  });

  it('POST /api/playtime validates types, lengths and duration (400 INVALID_PLAYTIME)', async () => {
    const base = { game: 'Playtime Game', platform: 'Steam', sessionStart: '2024-05-01T10:00:00.000Z', sessionEnd: '2024-05-01T11:00:00.000Z' };
    for (const bad of [
      {},
      { ...base, game: 42 },
      { ...base, game: 'x'.repeat(201) },
      { ...base, platform: 'p'.repeat(65) },
      { ...base, sessionStart: 'tomorrow' },
      { ...base, sessionEnd: '2024-05-01T10:00:20.000Z' },
      { ...base, sessionEnd: '2024-05-03T10:00:00.000Z' },
      { ...base, sessionStart: '1000-01-01T00:00:00.000Z', sessionEnd: '1000-01-01T01:00:00.000Z' },
      { ...base, sessionStart: '9999-01-01T00:00:00.000Z', sessionEnd: '9999-01-01T01:00:00.000Z' },
    ]) {
      const res = await api(request(app).post('/api/playtime')).send(bad);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.any(String), code: 'INVALID_PLAYTIME' });
    }
    const ok = await api(request(app).post('/api/playtime')).send({ ...base, extra: 'ignored' });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ success: true });
  });

  it("'all' over many years switches to bounded monthly buckets", async () => {
    await api(request(app).post('/api/playtime')).send({ game: 'Old Game', platform: 'Steam', sessionStart: '2003-02-10T10:00:00.000Z', sessionEnd: '2003-02-10T12:00:00.000Z' });
    const res = await api(request(app).get('/api/playtime/graph?range=all'));
    expect(res.status).toBe(200);
    expect(res.body.data.bucket).toBe('month');
    expect(res.body.data.line[0].date).toBe('2003-02-01');
    expect(res.body.data.line.length).toBeLessThan(12 * 30);
    expect(res.body.data.heatmap.find((p: { date: string }) => p.date === '2003-02-01').minutes).toBe(120);
    expect(JSON.stringify(res.body).length).toBeLessThan(100_000);
  });
});

// ── DUN-097 ──────────────────────────────────────────────────────────────────
describe('DUN-097: version history honors maxVersions across rows and dirs', () => {
  it('one sync session of 15 files keeps ONE snapshot with all 15 backups', async () => {
    await api(request(app).post('/api/settings')).send({ maxVersions: 3 });
    const files = Array.from({ length: 15 }, (_, i) => `slot${i}.sav`);
    for (const f of files) expect((await upload('Session Game', f, 'v1', '1700000000001')).status).toBe(200);
    for (const f of files) expect((await upload('Session Game', f, 'v2', '1700000000002')).status).toBe(200);
    const row = gameRow('Session Game');
    const records = listVersionRecords(row.id, ADMIN);
    expect(records.map((r) => r.id)).toEqual(['1700000000002']);
    const snap = path.join(getGameRoot(row.id, ADMIN), '.versions', '1700000000002');
    expect(fs.readdirSync(snap).sort()).toEqual([...files].sort());
    expect(fs.readFileSync(path.join(snap, 'slot7.sav'), 'utf-8')).toBe('v1');
  });

  it('prunes rows + dirs together to maxVersions, newest first, never the new version', async () => {
    await api(request(app).post('/api/settings')).send({ maxVersions: 3 });
    const base = Date.now() - 60_000;
    expect((await upload('Prune Game', 'a.sav', 'v0', String(base))).status).toBe(200);
    for (let i = 1; i <= 5; i += 1) {
      expect((await upload('Prune Game', 'a.sav', `v${i}`, String(base + i))).status).toBe(200);
    }
    const row = gameRow('Prune Game');
    expect(listVersionRecords(row.id, ADMIN).map((r) => r.id)).toEqual([String(base + 5), String(base + 4), String(base + 3)]);

    const created: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const v = await api(request(app).post('/api/save-versions')).send({ gameId: gameRow('Prune Game').id });
      expect(v.status).toBe(201);
      created.push(v.body.version.id);
      expect(getSaveVersion(v.body.version.id)).not.toBeNull(); // never pruned itself
    }
    const after = listVersionRecords(row.id, ADMIN);
    expect(after).toHaveLength(3);
    expect(after.map((r) => r.id)).toEqual(created.slice(1).reverse());
    // Pruned rows are gone from the DB and their dirs from disk.
    expect(getSaveVersion(created[0])).toBeNull();
    expect(fs.existsSync(path.join(getGameRoot(row.id, ADMIN), '.versions', created[0]))).toBe(false);
    expect(fs.existsSync(path.join(getGameRoot(row.id, ADMIN), '.versions', String(base + 5)))).toBe(false);
  });

  it('versions referenced by an unresolved conflict are kept', async () => {
    await api(request(app).post('/api/settings')).send({ maxVersions: 2 });
    expect((await upload('Conflict Keep', 'a.sav', '1')).status).toBe(200);
    const a = (await api(request(app).post('/api/save-versions')).send({ gameId: gameRow('Conflict Keep').id })).body.version.id;
    const b = (await api(request(app).post('/api/save-versions')).send({ gameId: gameRow('Conflict Keep').id })).body.version.id;
    recordConflict(gameRow('Conflict Keep').id, a, b);
    for (let i = 0; i < 3; i += 1) await api(request(app).post('/api/save-versions')).send({ gameId: gameRow('Conflict Keep').id });
    expect(getSaveVersion(a)).not.toBeNull();
    expect(getSaveVersion(b)).not.toBeNull();
  });

  it('x-sync-id must be digits (400 INVALID_SYNC_ID); absent = its own session', async () => {
    const bad = await upload('Sync Id Game', 'a.sav', 'x', 'default');
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: expect.any(String), code: 'INVALID_SYNC_ID' });
    expect((await upload('Sync Id Game', 'a.sav', 'x')).status).toBe(200);
    await api(request(app).post('/api/settings')).send({ maxVersions: 10 });
  });
});

// ── DUN-098 ──────────────────────────────────────────────────────────────────
describe('DUN-098: versions are atomic (files first, rows in one transaction)', () => {
  it('a failure before COMMIT leaves no version row and no file rows', () => {
    const game = database.ensureGame(ADMIN, 'Tx Game');
    const before = (getDb().prepare('SELECT COUNT(*) AS n FROM save_file_snapshots').get() as { n: number }).n;
    expect(() => createSaveVersion(
      { gameId: game.id, ownerId: ADMIN, files: [{ path: 'a', size: 1, hash: 'h', mtime: 'm' }, { path: 'b', size: 1, hash: 'h', mtime: 'm' }] },
      { id: '11111111-1111-4111-8111-111111111111', afterInsert: () => { throw new Error('publish failed'); } },
    )).toThrow('publish failed');
    expect(getSaveVersion('11111111-1111-4111-8111-111111111111')).toBeNull();
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM save_file_snapshots').get() as { n: number }).n).toBe(before);
  });

  it.skipIf(process.getuid?.() === 0)('a copy failure removes the staging dir and leaves no row', async () => {
    expect((await upload('Copy Fail Game', 'ok.sav', 'ok')).status).toBe(200);
    const row = gameRow('Copy Fail Game');
    const root = getGameRoot(row.id, ADMIN);
    const locked = path.join(root, 'locked.sav');
    fs.writeFileSync(locked, 'secret');
    fs.chmodSync(locked, 0o000);
    try {
      expect(() => createVersionFromDirectory({ gameId: row.id, ownerId: ADMIN })).toThrow();
    } finally {
      fs.chmodSync(locked, 0o600);
    }
    const versionsRoot = path.join(root, '.versions');
    expect(fs.existsSync(versionsRoot) ? fs.readdirSync(versionsRoot) : []).toEqual([]);
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM save_versions WHERE gameId = ?').get(row.id) as { n: number }).n).toBe(0);
  });

  it('a stored version records the bytes that were copied, and its dir exists', async () => {
    expect((await upload('Hash Game', 'a.sav', 'abc')).status).toBe(200);
    const v = await api(request(app).post('/api/save-versions')).send({ gameId: gameRow('Hash Game').id });
    const detail = getSaveVersion(v.body.version.id)!;
    expect(detail.files).toEqual([expect.objectContaining({ path: 'a.sav', size: 3, hash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' })]);
    const dir = path.join(getGameRoot(gameRow('Hash Game').id, ADMIN), '.versions', v.body.version.id);
    expect(fs.readFileSync(path.join(dir, 'a.sav'), 'utf-8')).toBe('abc');
  });
});

// ── DUN-100 ──────────────────────────────────────────────────────────────────
describe('DUN-100: local sync keys games by full folder path', () => {
  it('two different .../Saves folders stay two games (and stay separate on re-sync)', async () => {
    const root = path.join(TMP, 'local-src');
    for (const g of ['GameA', 'GameB']) {
      fs.mkdirSync(path.join(root, g, 'Saves'), { recursive: true });
      fs.writeFileSync(path.join(root, g, 'Saves', 'slot.sav'), `${g}-data`);
    }
    const src = database.addLocalSource(root);
    try {
      const first = await handleLocalSync(ADMIN);
      expect(first.success).toBe(true);
      expect(first.games).toHaveLength(2);
      expect(new Set(first.games).size).toBe(2);
      const ids = first.games.map((t) => gameRow(t).id);
      const contents = ids.map((id) => fs.readFileSync(path.join(getGameRoot(id, ADMIN), 'slot.sav'), 'utf-8')).sort();
      expect(contents).toEqual(['GameA-data', 'GameB-data']);

      fs.writeFileSync(path.join(root, 'GameB', 'Saves', 'slot.sav'), 'GameB-data-v2-longer');
      const second = await handleLocalSync(ADMIN);
      expect(second.count).toBe(1);
      const after = ids.map((id) => fs.readFileSync(path.join(getGameRoot(id, ADMIN), 'slot.sav'), 'utf-8')).sort();
      expect(after).toEqual(['GameA-data', 'GameB-data-v2-longer']);
    } finally {
      database.removeLocalSource(src.id);
    }
  });
});

// ── DUN-101 ──────────────────────────────────────────────────────────────────
describe('DUN-101: concurrent uploads never share temp files', () => {
  it('two concurrent uploads of one path both succeed, the file is one whole body, no temp left', async () => {
    const a = Buffer.alloc(256 * 1024, 'a');
    const b = Buffer.alloc(300 * 1024, 'b');
    const [r1, r2] = await Promise.all([upload('Race Game', 'slot.sav', a, '1700000000100'), upload('Race Game', 'slot.sav', b, '1700000000200')]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const row = gameRow('Race Game');
    const got = fs.readFileSync(path.join(getGameRoot(row.id, ADMIN), 'slot.sav'));
    expect(got.equals(a) || got.equals(b)).toBe(true);
    const ownerRoot = path.dirname(getGameRoot(row.id, ADMIN));
    expect(fs.readdirSync(ownerRoot).filter((n) => n.startsWith('.upload-') || n.startsWith('.extract-'))).toEqual([]);
    expect(fs.readdirSync(getGameRoot(row.id, ADMIN)).filter((n) => n.includes('.uploading') || n.includes('.part'))).toEqual([]);
  });

  it('a failed upload removes its private temp dir', async () => {
    const old = process.env.MAX_UPLOAD_MB;
    process.env.MAX_UPLOAD_MB = '1';
    try {
      const res = await upload('Race Game', 'big.sav', Buffer.alloc(2 * 1024 * 1024, 'x'), '1700000000300');
      expect(res.status).toBe(413);
    } finally {
      if (old === undefined) delete process.env.MAX_UPLOAD_MB; else process.env.MAX_UPLOAD_MB = old;
    }
    const ownerRoot = path.dirname(getGameRoot(gameRow('Race Game').id, ADMIN));
    expect(fs.readdirSync(ownerRoot).filter((n) => n.startsWith('.upload-'))).toEqual([]);
  });

  it('concurrent remote pushes zip into distinct private temp files, always cleaned up', async () => {
    expect((await upload('Push Game', 'a.sav', 'push')).status).toBe(200);
    const row = gameRow('Push Game');
    const server = database.addRemoteServer('http://peer.test:3030');
    const seen: string[] = [];
    postMock.mockImplementation(async (_url: unknown, data: unknown) => {
      const p = String((data as { path: string }).path);
      seen.push(p);
      expect(fs.existsSync(p)).toBe(true);
      expect(path.basename(path.dirname(p))).toMatch(/^dune-remote-sync-/);
      return { data: { success: true } };
    });
    try {
      await Promise.all([
        triggerRemoteSync([{ id: row.id, name: row.name }], ADMIN),
        triggerRemoteSync([{ id: row.id, name: row.name }], ADMIN),
      ]);
    } finally {
      database.removeRemoteServer(server.id);
    }
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    for (const p of seen) expect(fs.existsSync(path.dirname(p))).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(getGameRoot(row.id, ADMIN)), `${row.id}_sync.zip`))).toBe(false);
  });
});

// ── DUN-102 ──────────────────────────────────────────────────────────────────
describe('DUN-102: rate limits and key transport', () => {
  it('after AUTH_FAIL_MAX bad keys the IP gets 429 RATE_LIMITED, even with a good key', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await request(app).get('/api/saves').set('x-api-key', `wrong-${i}`)).status).toBe(403);
    }
    const blocked = await api(request(app).get('/api/saves'));
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: expect.any(String), code: 'RATE_LIMITED' });
    expect(blocked.headers['retry-after']).toBeDefined();
    expect((await api(request(app).get('/api/settings'))).status).toBe(429);
    // Liveness, readiness and the dashboard are never limited.
    expect((await request(app).get('/health')).status).toBe(200);
    expect((await request(app).get('/')).status).toBe(200);
    authFailureLimiter.reset();
    expect((await api(request(app).get('/api/saves'))).status).toBe(200);
  });

  it('valid keys and key-less requests never count as failures', async () => {
    for (let i = 0; i < 10; i += 1) expect((await api(request(app).get('/api/saves'))).status).toBe(200);
    for (let i = 0; i < 10; i += 1) expect((await request(app).get('/api/saves')).status).toBe(401);
    expect((await api(request(app).get('/api/saves'))).status).toBe(200);
  });

  it('the limiter window expires and the IP table is bounded', () => {
    vi.useFakeTimers();
    try {
      const lim = createAuthFailureLimiter({ max: 1, windowMs: 1000, maxTrackedIps: 2 });
      const res = { statusCode: 200, headers: {} as Record<string, string>, body: undefined as unknown,
        setHeader(k: string, v: string) { this.headers[k] = v; }, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; } };
      const next = vi.fn();
      const req = (ip: string) => ({ ip }) as never;
      lim.recordFailure(req('1.1.1.1'));
      lim.guard(req('1.1.1.1'), res as never, next);
      expect(res.statusCode).toBe(429);
      expect(res.body).toEqual({ error: expect.any(String), code: 'RATE_LIMITED' });
      vi.advanceTimersByTime(1001);
      lim.guard(req('1.1.1.1'), res as never, next);
      expect(next).toHaveBeenCalledTimes(1);
      lim.recordFailure(req('2.2.2.2'));
      lim.recordFailure(req('3.3.3.3'));
      lim.recordFailure(req('4.4.4.4')); // evicts the oldest
      lim.guard(req('2.2.2.2'), res as never, next);
      expect(next).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('trust proxy is off by default and configurable via TRUST_PROXY', () => {
    expect(app.get('trust proxy')).toBe(false);
    expect(trustProxySetting(undefined)).toBe(false);
    expect(trustProxySetting('')).toBe(false);
    expect(trustProxySetting('false')).toBe(false);
    expect(trustProxySetting('true')).toBe(true);
    expect(trustProxySetting('2')).toBe(2);
    expect(trustProxySetting('loopback')).toBe('loopback');
  });

  it('X-Forwarded-For is ignored while trust proxy is off (no spoofing the limiter)', async () => {
    for (let i = 0; i < 5; i += 1) {
      await request(app).get('/api/saves').set('x-api-key', 'bad').set('X-Forwarded-For', `10.0.0.${i}`);
    }
    expect((await api(request(app).get('/api/saves')).set('X-Forwarded-For', '10.9.9.9')).status).toBe(429);
  });
});

// ── DUN-103 ──────────────────────────────────────────────────────────────────
describe('DUN-103: backup profiles validate globs and apply autoExcludeCache', () => {
  it.each([
    [[1, 2]],
    ['**/*.log'],
    [[{}]],
    [['']],
    [['x'.repeat(257)]],
    [Array.from({ length: 101 }, (_, i) => `**/${i}`)],
  ])('excludeGlobs %j -> 400 INVALID_EXCLUDE_GLOBS', async (excludeGlobs) => {
    const res = await api(request(app).post('/api/backup-profile')).send({ game: 'Profile Game', excludeGlobs });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.any(String), code: 'INVALID_EXCLUDE_GLOBS' });
  });

  it('other fields are typed too', async () => {
    expect((await api(request(app).post('/api/backup-profile')).send({ game: 'Profile Game', includeGlobs: [5] })).body.code).toBe('INVALID_INCLUDE_GLOBS');
    expect((await api(request(app).post('/api/backup-profile')).send({ game: 'Profile Game', autoExcludeCache: 'yes' })).body.code).toBe('INVALID_BACKUP_PROFILE');
    expect((await api(request(app).post('/api/backup-profile')).send({ game: 'Profile Game', maxFileSizeMB: -1 })).body.code).toBe('INVALID_BACKUP_PROFILE');
  });

  it('autoExcludeCache keeps cache files out of new snapshots; absent fields keep stored values', async () => {
    expect((await upload('Profile Game', 'slot.sav', 's')).status).toBe(200);
    expect((await upload('Profile Game', 'cache/shader.bin', 'c')).status).toBe(200);
    expect((await upload('Profile Game', 'notes.txt', 'n')).status).toBe(200);

    const got = await api(request(app).get('/api/backup-profile?game=Profile%20Game'));
    expect(got.body.profile).toMatchObject({ excludeGlobs: [], autoExcludeCache: true });
    expect(got.body.cacheExcludeGlobs).toContain('**/cache/**');

    const v1 = await api(request(app).post('/api/save-versions')).send({ gameId: gameRow('Profile Game').id });
    expect(getSaveVersion(v1.body.version.id)!.files.map((f) => f.path)).toEqual(['notes.txt', 'slot.sav']);

    // Client echoes the whole profile back (gameId/updatedAt are ignored).
    const set = await api(request(app).post('/api/backup-profile')).send({ ...got.body.profile, game: 'Profile Game', excludeGlobs: ['**/*.txt'] });
    expect(set.status).toBe(200);
    expect(set.body.profile).toMatchObject({ excludeGlobs: ['**/*.txt'], autoExcludeCache: true });
    const kept = await api(request(app).post('/api/backup-profile')).send({ game: 'Profile Game', autoExcludeCache: false });
    expect(kept.body.profile).toMatchObject({ excludeGlobs: ['**/*.txt'], autoExcludeCache: false });

    const v2 = await api(request(app).post('/api/save-versions')).send({ gameId: gameRow('Profile Game').id });
    expect(getSaveVersion(v2.body.version.id)!.files.map((f) => f.path)).toEqual(['cache/shader.bin', 'slot.sav']);

    // DUN-067: an exclude rule never hides or deletes stored versions.
    expect(getSaveVersion(v1.body.version.id)!.files.map((f) => f.path)).toEqual(['notes.txt', 'slot.sav']);
    const listed = await api(request(app).get(`/api/save-versions?gameId=${gameRow('Profile Game').id}`));
    expect(listed.body.versions.map((v: { id: string }) => v.id)).toEqual(expect.arrayContaining([v1.body.version.id, v2.body.version.id]));
    const dir = path.join(getGameRoot(gameRow('Profile Game').id, ADMIN), '.versions', v1.body.version.id);
    expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(true);
  });
});

// ── DUN-105 (route) ──────────────────────────────────────────────────────────
describe('DUN-105: HLTB route', () => {
  it('is opt-in: off by default -> PROVIDER_DISABLED with no outbound request; flag must be boolean', async () => {
    getMock.mockClear();
    postMock.mockClear();
    const settings = await api(request(app).get('/api/settings'));
    expect(settings.body.settings).toMatchObject({ hltbEnabled: false, artworkEnabled: false });
    const off = await api(request(app).get('/api/hltb/Offline%20Game'));
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ success: false, code: 'PROVIDER_DISABLED' });
    expect(getMock).not.toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
    for (const bad of ['true', 1, null]) {
      const r = await api(request(app).post('/api/settings')).send({ hltbEnabled: bad });
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ code: 'INVALID_SETTINGS' });
    }
    const on = await api(request(app).post('/api/settings')).send({ hltbEnabled: true });
    expect(on.status).toBe(200);
    expect((await api(request(app).get('/api/settings'))).body.settings.hltbEnabled).toBe(true);
  });

  it('rejects an invalid title with 400 and reports a typed failure offline', async () => {
    await api(request(app).post('/api/settings')).send({ hltbEnabled: true });
    const bad = await api(request(app).get(`/api/hltb/${encodeURIComponent('bad\u0001title')}`));
    expect(bad.status).toBe(400);
    const res = await api(request(app).get('/api/hltb/Offline%20Game'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: false, code: 'HLTB_UNAVAILABLE' });
  });
});
