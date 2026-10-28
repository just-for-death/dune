// FEAT-server-gamePatch: PATCH /api/games/:id sets or clears steamAppId / gogId.
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';

// Own temp DATA_DIR (never packages/server/data). Must precede the dynamic import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-gamepatch-test-'));
const SETUP_DATA_DIR = process.env.DATA_DIR as string; // temp dir from src/test/setup.ts (DUN-005)
process.env.DATA_DIR = TMP;
process.env.API_KEY_SECRET = 'gamepatch-secret-0123456789abcdef';

const { app } = await import('./server.js');
const { database } = await import('./db/index.js');

const ADMIN = database.listUsers().find((u) => u.role === 'admin')!.id;
const KEY = database.issueUserKey(ADMIN, 'gamepatch admin');
const member = database.createUser(`gamepatch-member-${Date.now()}`, 'member');
const MEMBER_KEY = database.issueUserKey(member.id, 'member');

const mine = database.ensureGame(member.id, 'Hollow Knight', { steamAppId: '367520', gogId: '1308320804' });
const adminGame = database.ensureGame(ADMIN, 'Celeste', { gogId: '1955430409' });

const patch = (id: number | string, body: unknown, key: string | null = MEMBER_KEY) => {
  const r = request(app).patch(`/api/games/${id}`);
  if (key) r.set('x-api-key', key);
  return r.send(body as object);
};

afterAll(() => {
  process.env.DATA_DIR = SETUP_DATA_DIR; // restore the temp dir, never unset (DUN-005)
  delete process.env.API_KEY_SECRET;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('PATCH /api/games/:id', () => {
  it('401 without an API key', async () => {
    const r = await patch(mine.id, { steamAppId: '620' }, null);
    expect(r.status).toBe(401);
    expect(Object.keys(r.body).sort()).toEqual(['code', 'error']);
  });

  it('400 INVALID_GAME_ID for an invalid :id', async () => {
    for (const bad of ['abc', '0', '-1', 'Infinity']) {
      const r = await patch(bad, { steamAppId: '620' });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('INVALID_GAME_ID');
      expect(Object.keys(r.body).sort()).toEqual(['code', 'error']);
    }
  });

  it('400 INVALID_GAME_UPDATE for {}, an unknown key or a non-object body; nothing changes', async () => {
    for (const body of [{}, { steamAppId: '620', name: 'x' }, { owner: ADMIN, gogId: '1' }, { foo: 1 }, ['620']]) {
      const r = await patch(mine.id, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.code).toBe('INVALID_GAME_UPDATE');
      expect(Object.keys(r.body).sort()).toEqual(['code', 'error']);
    }
    const noBody = await request(app).patch(`/api/games/${mine.id}`).set('x-api-key', MEMBER_KEY);
    expect(noBody.status).toBe(400);
    expect(noBody.body.code).toBe('INVALID_GAME_UPDATE');
    expect(database.getGameById(mine.id)).toMatchObject({ steamAppId: '367520', gogId: '1308320804' });
  });

  it('400 INVALID_STORE_ID for a bad id value; nothing changes', async () => {
    for (const body of [{ steamAppId: 'abc' }, { steamAppId: 367520 }, { gogId: '0123' }, { gogId: '' }, { gogId: '1234567890123' }, { steamAppId: '620', gogId: false }]) {
      const r = await patch(mine.id, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.code).toBe('INVALID_STORE_ID');
      expect(Object.keys(r.body).sort()).toEqual(['code', 'error']);
    }
    expect(database.getGameById(mine.id)).toMatchObject({ steamAppId: '367520', gogId: '1308320804' });
  });

  it('404 GAME_NOT_FOUND for another user\'s game (not 403) and for a missing game', async () => {
    const foreign = await patch(adminGame.id, { gogId: null });
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual({ error: 'Game not found', code: 'GAME_NOT_FOUND' });
    // An admin without ?owner= is scoped to their own games too.
    expect((await patch(mine.id, { steamAppId: '1' }, KEY)).status).toBe(404);
    expect((await patch(999999, { steamAppId: '1' })).status).toBe(404);
    expect(database.getGameById(adminGame.id)).toMatchObject({ gogId: '1955430409' });
    expect(database.getGameById(mine.id)).toMatchObject({ steamAppId: '367520' });
  });

  it('a partial update changes one id and keeps the other; returns the updated game', async () => {
    const r = await patch(mine.id, { steamAppId: '620' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, game: { id: mine.id, name: 'Hollow Knight', steamAppId: '620', gogId: '1308320804' } });
    expect(database.getGameById(mine.id)).toMatchObject({ steamAppId: '620', gogId: '1308320804' });
  });

  it('null clears an id; both can be set in one call', async () => {
    const cleared = await patch(mine.id, { gogId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.game).toMatchObject({ steamAppId: '620', gogId: null });
    const both = await patch(mine.id, { steamAppId: null, gogId: '1207658924' });
    expect(both.body.game).toMatchObject({ steamAppId: null, gogId: '1207658924' });
    // GET /api/saves reflects it.
    const saves = await request(app).get('/api/saves').set('x-api-key', MEMBER_KEY);
    expect(saves.body.games.find((g: { id: number }) => g.id === mine.id)).toMatchObject({ steamAppId: null, gogId: '1207658924' });
  });

  it('an admin reaches another owner\'s game with ?owner=', async () => {
    const r = await request(app).patch(`/api/games/${mine.id}?owner=${member.id}`).set('x-api-key', KEY).send({ steamAppId: '367520' });
    expect(r.status).toBe(200);
    expect(r.body.game).toMatchObject({ steamAppId: '367520', gogId: '1207658924' });
  });

  it('CORS preflight allows PATCH', async () => {
    const r = await request(app)
      .options('/api/games/1')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'PATCH');
    expect(String(r.headers['access-control-allow-methods'] ?? '')).toContain('PATCH');
  });
});
