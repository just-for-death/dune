import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';

// Full-stack (Express middleware + auth + SQLite) multi-user isolation test.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-multiuser-test-'));
process.env.DATA_DIR = TMP;
process.env.API_KEY_SECRET = 'multiuser-secret-0123456789abcdef';

const { app } = await import('./server.js');
const { database } = await import('./db/index.js');

const ADMIN_KEY = 'admin-int-test-key-0123456789';
database.addApiKey(ADMIN_KEY, 'Multi-user test admin');

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
  delete process.env.DATA_DIR;
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

  it('rejects cross-user reads and writes (403)', async () => {
    expect((await asMember(request(app).get('/api/list-files?game=AdminGame'))).status).toBe(403);
    expect((await asMember(request(app).get('/api/manifest?game=AdminGame'))).status).toBe(403);
    expect((await asMember(request(app).get('/api/download-file?game=AdminGame&path=save.sav'))).status).toBe(403);
    expect((await asMember(request(app).delete('/api/file?game=AdminGame&path=save.sav'))).status).toBe(403);

    // A member cannot upload into another user's game either.
    const blocked = await asMember(upload(request(app).post('/api/upload-file'), 'AdminGame', 'evil.sav', Buffer.from('X')));
    expect(blocked.status).toBe(403);

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
