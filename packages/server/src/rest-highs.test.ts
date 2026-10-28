/** REST contract for DUN-089 (archive errors), DUN-090 (restore result), DUN-091 (relay header). */
import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-rest-highs-test-'));
const SETUP_DATA_DIR = process.env.DATA_DIR as string;
process.env.DATA_DIR = TMP;
process.env.API_KEY_SECRET = 'rest-highs-secret-0123456789abcdef';

const trigger = vi.hoisted(() => vi.fn(async (_games: unknown, _ownerId?: string) => undefined));
vi.mock('./services/remoteSync.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./services/remoteSync.js')>()),
  triggerRemoteSync: trigger,
}));

const { app } = await import('./server.js');
const { database } = await import('./db/index.js');
const { closeDbForTests } = await import('./db/sqlite.js');
const KEY = 'rest-highs-admin-key-0123456789';
database.addApiKey(KEY);
const ADMIN = database.listUsers()[0].id;

afterAll(() => {
  closeDbForTests();
  process.env.DATA_DIR = SETUP_DATA_DIR;
  delete process.env.API_KEY_SECRET;
  fs.rmSync(TMP, { recursive: true, force: true });
});
beforeEach(async () => { await new Promise((r) => setImmediate(r)); trigger.mockClear(); });

const upload = (game: string, rel: string, body: Buffer | string, relay = false) => {
  const r = request(app).post('/api/upload-file').set('x-api-key', KEY)
    .set('Content-Type', 'application/octet-stream')
    .set('x-game', encodeURIComponent(game)).set('x-path', encodeURIComponent(rel))
    .set('x-sync-id', String(Date.now()));
  return (relay ? r.set('x-dune-relay', '1') : r).send(Buffer.from(body));
};
function zipOf(files: Record<string, string>): Buffer {
  const dir = fs.mkdtempSync(path.join(TMP, 'zipsrc-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  execFileSync('zip', ['-r', '-q', path.join(dir, 'out.zip'), '.'], { cwd: dir });
  const buf = fs.readFileSync(path.join(dir, 'out.zip'));
  fs.rmSync(dir, { recursive: true, force: true });
  return buf;
}

describe('upload-file', () => {
  it('a broken saves.zip is 400 {error, code: ARCHIVE_INVALID}, not 200 (DUN-089)', async () => {
    const res = await upload('REST Zip', 'saves.zip', 'definitely not a zip');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.any(String), code: 'ARCHIVE_INVALID' });
  });

  it('client uploads trigger a push for the owner; x-dune-relay: 1 uploads do not (DUN-091)', async () => {
    expect((await upload('REST Relay', 'saves.zip', zipOf({ 'a.sav': '1' }))).status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger.mock.calls[0][1]).toBe(ADMIN);
    trigger.mockClear();
    expect((await upload('REST Relay', 'saves.zip', zipOf({ 'a.sav': '2' }), true)).status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(trigger).not.toHaveBeenCalled();
  });
});

describe('restore-version (DUN-090)', () => {
  it('returns restoredFiles, removedFiles and preRestoreVersionId', async () => {
    const up = await upload('REST Restore', 'a.sav', 'one');
    const v = await request(app).post('/api/save-versions').set('x-api-key', KEY).send({ gameId: up.body.gameId });
    expect(v.status).toBe(201);
    const versionId = (v.body.version ?? v.body).id as string;
    await upload('REST Restore', 'b.sav', 'two');
    const res = await request(app).post('/api/restore-version').set('x-api-key', KEY).send({ gameId: up.body.gameId, versionId });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, restoredFiles: 1, removedFiles: 1, preRestoreVersionId: expect.any(String) });
  });
});
