// FEAT-server-storeIds: x-steam-app-id / x-gog-id on POST /api/upload-file,
// returned by GET /api/saves, used by GET /api/manifest/:gameId.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';

vi.mock('axios');
import axios from 'axios';

// Own temp DATA_DIR (never packages/server/data). Must precede the dynamic import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-storeids-route-test-'));
const SETUP_DATA_DIR = process.env.DATA_DIR as string; // temp dir from src/test/setup.ts (DUN-005)
process.env.DATA_DIR = TMP;
process.env.API_KEY_SECRET = 'storeids-route-secret-0123456789abcdef';

const getMock = vi.mocked(axios.get);
const postMock = vi.mocked(axios.post);

const { app } = await import('./server.js');
const { database } = await import('./db/index.js');

const ADMIN = database.listUsers().find((u) => u.role === 'admin')!.id;
const KEY = database.issueUserKey(ADMIN, 'storeids admin');
const member = database.createUser(`storeids-member-${Date.now()}`, 'member');
const MEMBER_KEY = database.issueUserKey(member.id, 'member');

function upload(game: string, key: string, ids: Record<string, string> = {}): request.Test {
  let r = request(app)
    .post('/api/upload-file')
    .set('x-api-key', key)
    .set('Content-Type', 'application/octet-stream')
    .set('x-game', encodeURIComponent(game))
    .set('x-path', encodeURIComponent('save.dat'));
  for (const [k, v] of Object.entries(ids)) r = r.set(k, v);
  return r.send(Buffer.from('save'));
}

const saves = async (key: string) =>
  (await request(app).get('/api/saves').set('x-api-key', key)).body.games as Array<{ name: string; steamAppId: string | null; gogId: string | null }>;

const YAML = [
  '---',
  'Hollow Knight:',
  '  files:',
  '    "<home>/.config/unity3d/Team Cherry/Hollow Knight/*.dat":',
  '      tags: [save]',
  '  steam:',
  '    id: 367520',
  'Celeste:',
  '  gog:',
  '    id: 1955430409',
  '  files:',
  '    "<home>/.local/share/Celeste/Saves":',
  '',
].join('\n');

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  getMock.mockRejectedValue(new Error('offline'));
  postMock.mockRejectedValue(new Error('offline'));
});

afterAll(() => {
  process.env.DATA_DIR = SETUP_DATA_DIR; // restore the temp dir, never unset (DUN-005)
  delete process.env.API_KEY_SECRET;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('POST /api/upload-file store id headers', () => {
  it('400 INVALID_STORE_ID ({error, code} only) for invalid values; no game row, no file', async () => {
    const bad = ['abc', '0', '0123', '-5', '1.5', '1e5', '1234567890123', '', '42, 43', '42abc'];  // HTTP itself trims surrounding header whitespace
    for (const header of ['x-steam-app-id', 'x-gog-id']) {
      for (const v of bad) {
        const r = await upload(`Bad ${header} ${v}`, KEY, { [header]: v });
        expect(r.status, `${header}=${JSON.stringify(v)}`).toBe(400);
        expect(r.body.code).toBe('INVALID_STORE_ID');
        expect(r.body.error).toMatch(new RegExp(`^${header}: `));
        expect(Object.keys(r.body).sort()).toEqual(['code', 'error']);
        expect(database.findGame(ADMIN, `Bad ${header} ${v}`)).toBeUndefined();
      }
    }
  });

  it('a repeated header is rejected', async () => {
    const r = await request(app)
      .post('/api/upload-file')
      .set('x-api-key', KEY)
      .set('x-game', 'Dup')
      .set('x-path', 'save.dat')
      // Two header lines (supertest sends an array as repeated headers).
      .set('x-steam-app-id', ['367520', '620'] as unknown as string)
      .send(Buffer.from('save'));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_STORE_ID');
  });

  it('stores valid ids on create and returns them in GET /api/saves; no headers = null', async () => {
    expect((await upload('Hollow Knight', KEY, { 'x-steam-app-id': '367520' })).status).toBe(200);
    expect((await upload('Celeste', KEY, { 'x-gog-id': '1955430409' })).status).toBe(200);
    expect((await upload('No Ids', KEY)).status).toBe(200);
    expect((await upload('Max Len', KEY, { 'x-steam-app-id': '999999999999', 'x-gog-id': '1' })).status).toBe(200);
    const games = await saves(KEY);
    expect(games.find((g) => g.name === 'Hollow Knight')).toMatchObject({ steamAppId: '367520', gogId: null });
    expect(games.find((g) => g.name === 'Celeste')).toMatchObject({ steamAppId: null, gogId: '1955430409' });
    expect(games.find((g) => g.name === 'No Ids')).toMatchObject({ steamAppId: null, gogId: null });
    expect(games.find((g) => g.name === 'Max Len')).toMatchObject({ steamAppId: '999999999999', gogId: '1' });
  });

  it('a later sync updates the given id and keeps an absent one', async () => {
    expect((await upload('hollow knight', KEY, { 'x-gog-id': '1308320804' })).status).toBe(200);
    expect((await upload('Hollow Knight', KEY)).status).toBe(200);
    expect((await saves(KEY)).find((g) => g.name === 'Hollow Knight')).toMatchObject({ steamAppId: '367520', gogId: '1308320804' });
    // An invalid value on an existing game is a 400 and changes nothing.
    expect((await upload('Hollow Knight', KEY, { 'x-steam-app-id': 'nope' })).status).toBe(400);
    expect((await saves(KEY)).find((g) => g.name === 'Hollow Knight')).toMatchObject({ steamAppId: '367520' });
  });

  it('multi-user isolation: same title per user, ids never cross owners', async () => {
    expect((await upload('Hollow Knight', MEMBER_KEY, { 'x-steam-app-id': '620' })).status).toBe(200);
    const mine = (await saves(MEMBER_KEY)).filter((g) => g.name === 'Hollow Knight');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ steamAppId: '620', gogId: null });
    expect(database.findGame(ADMIN, 'Hollow Knight')).toMatchObject({ steamAppId: '367520', gogId: '1308320804' });
    // The member sees only their own row.
    expect((await saves(MEMBER_KEY)).map((g) => g.name)).toEqual(['Hollow Knight']);
  });

  it('CORS allows the two headers', async () => {
    const r = await request(app)
      .options('/api/upload-file')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-steam-app-id,x-gog-id');
    const allowed = String(r.headers['access-control-allow-headers'] ?? '').toLowerCase();
    expect(allowed).toContain('x-steam-app-id');
    expect(allowed).toContain('x-gog-id');
  });
});

describe('GET /api/manifest/:gameId uses the stored ids', () => {
  it('Steam id, then GOG id, then title', async () => {
    await request(app).post('/api/settings').set('x-api-key', KEY).send({ manifestEnabled: true });
    expect((await upload('HK renamed', KEY, { 'x-steam-app-id': '367520' })).status).toBe(200);
    expect((await upload('Celeste renamed', KEY, { 'x-steam-app-id': '111', 'x-gog-id': '1955430409' })).status).toBe(200);
    getMock.mockResolvedValueOnce({ status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', etag: '"v1"' }, data: YAML } as never);
    const title = async (name: string) => {
      const id = database.findGame(ADMIN, name)!.id;
      const r = await request(app).get(`/api/manifest/${id}`).set('x-api-key', KEY);
      return r.status === 200 ? r.body.entry.title : r.body.code;
    };
    expect(await title('HK renamed')).toBe('Hollow Knight'); // by Steam id
    expect(await title('Celeste renamed')).toBe('Celeste'); // Steam id unknown -> GOG id
    expect(await title('Celeste')).toBe('Celeste'); // GOG id
    expect(await title('No Ids')).toBe('MANIFEST_NOT_FOUND'); // title only, not listed
    expect(getMock).toHaveBeenCalledTimes(1);
  });
});
