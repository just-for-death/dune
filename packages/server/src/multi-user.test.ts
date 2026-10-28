import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';

// Full-stack (Express middleware + auth + SQLite) multi-user isolation test.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-multiuser-test-'));
const SETUP_DATA_DIR = process.env.DATA_DIR as string; // temp dir from src/test/setup.ts (DUN-005)
process.env.DATA_DIR = TMP;
process.env.API_KEY_SECRET = 'multiuser-secret-0123456789abcdef';

const { app } = await import('./server.js');
const { database } = await import('./db/index.js');

// DUN-110: database.addApiKey (test-only) is gone; issue a real admin key.
const ADMIN_KEY = database.issueUserKey(database.listUsers().find((u) => u.role === 'admin')!.id, 'Multi-user test admin');
const adminId = database.resolveUserByKey(ADMIN_KEY)!.id;

let memberKey = '';
let memberId = '';

const asAdmin = (t: request.Test) => t.set('x-api-key', ADMIN_KEY);
const asMember = (t: request.Test) => t.set('x-api-key', memberKey);

beforeAll(async () => {
  const res = await request(app)
    .post('/api/users')
    .set('x-api-key', ADMIN_KEY)
    .send({ name: 'IsolationMember', role: 'member' });
  expect(res.status).toBe(201);
  memberKey = res.body.apiKey;
  memberId = res.body.user.id;
});

afterAll(() => {
  process.env.DATA_DIR = SETUP_DATA_DIR; // restore the temp dir, never unset (DUN-005)
  delete process.env.API_KEY_SECRET;
  fs.rmSync(TMP, { recursive: true, force: true });
});

const upload = (t: request.Test, game: string, file: string, body: Buffer) =>
  t
    .set('x-game', game)
    .set('x-path', file)
    .set('x-sync-id', Date.now().toString())
    .set('Content-Type', 'application/octet-stream')
    .send(body);

describe('multi-user isolation over HTTP', () => {
  it('records the caller identity from the key', async () => {
    const me = await asMember(request(app).get('/api/users/me'));
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ id: memberId, role: 'member' });
  });

  it('lets each user upload their own game and scopes the listing', async () => {
    const a = await asAdmin(upload(request(app).post('/api/upload-file'), 'AdminGame', 'save.sav', Buffer.from('ADMIN-DATA')));
    expect(a.body.success).toBe(true);

    const m = await asMember(upload(request(app).post('/api/upload-file'), 'MemberGame', 'save.sav', Buffer.from('MEMBER-DATA')));
    expect(m.body.success).toBe(true);

    const memberSaves = await asMember(request(app).get('/api/saves'));
    expect(memberSaves.body.games.map((g: { name: string }) => g.name)).toEqual(['MemberGame']);

    const adminSaves = await asAdmin(request(app).get('/api/saves'));
    expect(adminSaves.body.games.map((g: { name: string }) => g.name).sort()).toEqual(['AdminGame', 'MemberGame']);
  });

  it('resolves titles only in the caller\'s namespace: another user\'s game is invisible (DUN-087/088)', async () => {
    // The member has no 'AdminGame': reads are empty / 404, never the admin's data.
    expect((await asMember(request(app).get('/api/list-files?game=AdminGame'))).body).toEqual({ success: true, files: [] });
    expect((await asMember(request(app).get('/api/manifest?game=AdminGame'))).body).toEqual({ success: true, files: [] });
    const dl = await asMember(request(app).get('/api/download-file?game=AdminGame&path=save.sav'));
    expect(dl.status).toBe(404);
    expect(dl.body).toEqual({ error: 'Game not found', code: 'GAME_NOT_FOUND' });
    expect((await asMember(request(app).delete('/api/file?game=AdminGame&path=save.sav'))).status).toBe(404);
    // A member can't target another owner explicitly either.
    const targeted = await asMember(request(app).get(`/api/download-file?game=AdminGame&path=save.sav&owner=${encodeURIComponent(adminId)}`));
    expect(targeted.status).toBe(403);

    // Uploading 'AdminGame' as the member creates the MEMBER's own game; the admin's is untouched.
    const own = await asMember(upload(request(app).post('/api/upload-file'), 'AdminGame', 'evil.sav', Buffer.from('X')));
    expect(own.status).toBe(200);
    const adminFiles = await asAdmin(request(app).get('/api/list-files?game=AdminGame'));
    expect(adminFiles.body.files.map((f: { path: string }) => f.path)).toEqual(['save.sav']);

    // The owner can read their own.
    expect((await asMember(request(app).get('/api/manifest?game=MemberGame'))).status).toBe(200);
  });

  it('keeps per-user file content separate on disk', async () => {
    const adminDl = await asAdmin(request(app).get('/api/download-file?game=AdminGame&path=save.sav'));
    const memberDl = await asMember(request(app).get('/api/download-file?game=MemberGame&path=save.sav'));
    expect(adminDl.body.toString()).toBe('ADMIN-DATA');
    expect(memberDl.body.toString()).toBe('MEMBER-DATA');
  });

  it('gatekeeps admin-only endpoints', async () => {
    expect((await asMember(request(app).get('/api/users'))).status).toBe(403);
    expect((await asMember(request(app).post('/api/users').send({ name: 'Nope' }))).status).toBe(403);
    expect((await asMember(request(app).post('/api/local-sync'))).status).toBe(403);
    expect((await asMember(request(app).post('/api/local-sources').send({ path: TMP }))).status).toBe(403);
    expect((await asMember(request(app).post('/api/remote-servers').send({ url: 'http://x:1' }))).status).toBe(403);

    // Admin can.
    expect((await asAdmin(request(app).get('/api/users'))).status).toBe(200);
  });

  it('ignores an unknown key entirely (401 without a key, 403 with a bad key)', async () => {
    expect((await request(app).get('/api/saves')).status).toBe(401);
    expect((await request(app).get('/api/saves').set('x-api-key', 'bogus')).status).toBe(403);
  });
});
