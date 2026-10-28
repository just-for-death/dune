// FEAT-server-manifest: GET /api/manifest/:gameId and Settings.manifestEnabled over HTTP.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';

vi.mock('axios');
import axios from 'axios';
import { LUDUSAVI_MANIFEST_URL, MANIFEST_ATTRIBUTION, MANIFEST_CACHE_TTL_MS } from '@dune/providers';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-manifest-route-test-'));
const SETUP_DATA_DIR = process.env.DATA_DIR as string; // temp dir from src/test/setup.ts (DUN-005)
process.env.DATA_DIR = TMP;
process.env.API_KEY_SECRET = 'manifest-secret-0123456789abcdef';

// The module-level provider captures Date.now when the app is imported; a
// pass-through spy lets the stale test move its clock past the 7-day TTL.
const realNow = Date.now.bind(Date);
const nowSpy = vi.spyOn(Date, 'now');

const getMock = vi.mocked(axios.get);
const postMock = vi.mocked(axios.post);

const { app } = await import('./server.js');
const { database } = await import('./db/index.js');

const ADMIN = database.listUsers().find((u) => u.role === 'admin')!.id;
const KEY = database.issueUserKey(ADMIN, 'manifest test admin');
const member = database.createUser(`manifest-member-${realNow()}`, 'member');
const MEMBER_KEY = database.issueUserKey(member.id, 'member');
const api = (req: request.Test, key = KEY) => req.set('x-api-key', key);

const YAML = [
  '---',
  'Hollow Knight:',
  '  files:',
  '    "<winLocalAppDataLow>/Team Cherry/Hollow Knight/*.dat":',
  '      tags: [save]',
  '      when: [{ os: windows }]',
  '    "<home>/.config/unity3d/Team Cherry/Hollow Knight/*.dat":',
  '      tags: [save]',
  '  launch:',
  '    "<base>/hollow_knight.exe": [{ arguments: "--evil" }]',
  '  steam:',
  '    id: 367520',
  '',
].join('\n');

function upload(game: string, key: string): request.Test {
  return request(app)
    .post('/api/upload-file')
    .set('x-api-key', key)
    .set('Content-Type', 'application/octet-stream')
    .set('x-game', encodeURIComponent(game))
    .set('x-path', encodeURIComponent('save.dat'))
    .send(Buffer.from('save'));
}

const setFlag = (manifestEnabled: unknown, key = KEY) => api(request(app).post('/api/settings'), key).send({ manifestEnabled });

let adminGame = 0;
let unknownGame = 0;
let memberGame = 0;

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  getMock.mockRejectedValue(new Error('offline'));
  postMock.mockRejectedValue(new Error('offline'));
});

afterAll(() => {
  nowSpy.mockRestore();
  process.env.DATA_DIR = SETUP_DATA_DIR; // restore the temp dir, never unset (DUN-005)
  delete process.env.API_KEY_SECRET;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('FEAT-server-manifest: Settings.manifestEnabled', () => {
  it('is off by default, strictly boolean and admin-only to change', async () => {
    const s = await api(request(app).get('/api/settings'));
    expect(s.body.settings).toMatchObject({ hltbEnabled: false, artworkEnabled: false, manifestEnabled: false });
    for (const bad of ['true', 1, null, {}]) {
      const r = await setFlag(bad);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: 'manifestEnabled must be true or false', code: 'INVALID_SETTINGS' });
    }
    const asMember = await setFlag(true, MEMBER_KEY);
    expect(asMember.status).toBe(403);
    expect(Object.keys(asMember.body).sort()).toEqual(['code', 'error']);
    expect((await api(request(app).get('/api/settings'), MEMBER_KEY)).body.settings.manifestEnabled).toBe(false);
    expect((await setFlag(true)).status).toBe(200);
    expect((await api(request(app).get('/api/settings'), MEMBER_KEY)).body.settings.manifestEnabled).toBe(true);
    // Other flags are untouched by a manifestEnabled-only patch.
    expect((await api(request(app).get('/api/settings'))).body.settings).toMatchObject({ hltbEnabled: false, artworkEnabled: false });
    expect((await setFlag(false)).status).toBe(200);
    expect((await api(request(app).get('/api/settings'))).body.settings.manifestEnabled).toBe(false);
  });
});

describe('FEAT-server-manifest: GET /api/manifest/:gameId', () => {
  it('setup: one game per user', async () => {
    expect((await upload('Hollow Knight', KEY)).status).toBe(200);
    expect((await upload('Unlisted Indie', KEY)).status).toBe(200);
    expect((await upload('Hollow Knight', MEMBER_KEY)).status).toBe(200);
    adminGame = database.findGame(ADMIN, 'Hollow Knight')!.id;
    unknownGame = database.findGame(ADMIN, 'Unlisted Indie')!.id;
    memberGame = database.findGame(member.id, 'Hollow Knight')!.id;
    expect(memberGame).not.toBe(adminGame);
  });

  it('requires an API key', async () => {
    const r = await request(app).get(`/api/manifest/${adminGame}`);
    expect(r.status).toBe(401);
    expect(Object.keys(r.body).sort()).toEqual(['code', 'error']);
  });

  it('disabled: 403 PROVIDER_DISABLED before the game lookup, with no outbound request', async () => {
    await setFlag(false);
    for (const id of [adminGame, 999999]) {
      const r = await api(request(app).get(`/api/manifest/${id}`));
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: 'Save-path manifest lookups are disabled (Settings.manifestEnabled)', code: 'PROVIDER_DISABLED' });
    }
    expect(getMock).not.toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('400 INVALID_GAME_ID for an invalid id (no request)', async () => {
    await setFlag(true);
    for (const bad of ['abc', '-1', '0', 'Infinity']) {
      const r = await api(request(app).get(`/api/manifest/${bad}`));
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('INVALID_GAME_ID');
      expect(Object.keys(r.body).sort()).toEqual(['code', 'error']);
    }
    expect(getMock).not.toHaveBeenCalled();
  });

  it('404 GAME_NOT_FOUND for a missing game and for another user\'s game (no request)', async () => {
    await setFlag(true);
    const missing = await api(request(app).get('/api/manifest/999999'));
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Game not found', code: 'GAME_NOT_FOUND' });
    const foreign = await api(request(app).get(`/api/manifest/${adminGame}`), MEMBER_KEY);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual({ error: 'Game not found', code: 'GAME_NOT_FOUND' });
    // An admin without `owner` is scoped to their own games too.
    expect((await api(request(app).get(`/api/manifest/${memberGame}`))).body.code).toBe('GAME_NOT_FOUND');
    expect(getMock).not.toHaveBeenCalled();
  });

  it('enabled: returns the entry, PCGamingWiki page and attribution; paths are data only', async () => {
    await setFlag(true);
    getMock.mockResolvedValueOnce({ status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', etag: '"v1"' }, data: YAML } as never);
    const r = await api(request(app).get(`/api/manifest/${adminGame}`));
    expect(r.status).toBe(200);
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock.mock.calls[0]![0]).toBe(LUDUSAVI_MANIFEST_URL);
    expect(getMock.mock.calls[0]![1]!.timeout).toBeGreaterThanOrEqual(60_000);
    expect(r.body).toEqual({
      success: true,
      entry: {
        title: 'Hollow Knight',
        files: {
          '<winLocalAppDataLow>/Team Cherry/Hollow Knight/*.dat': { tags: ['save'], when: [{ os: 'windows' }] },
          '<home>/.config/unity3d/Team Cherry/Hollow Knight/*.dat': { tags: ['save'] },
        },
        steam: { id: 367520 },
      },
      pageUrl: 'https://www.pcgamingwiki.com/wiki/Hollow_Knight',
      attribution: { ...MANIFEST_ATTRIBUTION },
    });
    // Cached under the temp DATA_DIR, never packages/server/data.
    expect(fs.existsSync(path.join(TMP, 'manifest-cache', 'ludusavi-manifest.json'))).toBe(true);
  });

  it('member sees their own game; admin reaches it with an explicit owner; no second download', async () => {
    const mine = await api(request(app).get(`/api/manifest/${memberGame}`), MEMBER_KEY);
    expect(mine.status).toBe(200);
    expect(mine.body.entry.title).toBe('Hollow Knight');
    const asAdmin = await api(request(app).get(`/api/manifest/${memberGame}?owner=${member.id}`));
    expect(asAdmin.status).toBe(200);
    expect(getMock).not.toHaveBeenCalled();
  });

  it('404 MANIFEST_NOT_FOUND when the game has no manifest entry', async () => {
    const r = await api(request(app).get(`/api/manifest/${unknownGame}`));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'Game not found in the save-path manifest', code: 'MANIFEST_NOT_FOUND' });
  });

  it('stale: past the TTL with the source unreachable, the cached copy is served with stale: true', async () => {
    nowSpy.mockImplementation(() => realNow() + MANIFEST_CACHE_TTL_MS + 24 * 60 * 60 * 1000);
    try {
      const r = await api(request(app).get(`/api/manifest/${adminGame}`));
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ success: true, stale: true, entry: { title: 'Hollow Knight' }, attribution: { license: 'CC BY-NC-SA 3.0' } });
      expect(getMock).toHaveBeenCalledTimes(1);
      expect((getMock.mock.calls[0]![1]!.headers as Record<string, string>)['If-None-Match']).toBe('"v1"');
    } finally {
      nowSpy.mockImplementation(realNow);
    }
  });

  it('does not shadow the delta-sync GET /api/manifest?game=', async () => {
    const r = await api(request(app).get('/api/manifest?game=Hollow%20Knight'));
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(Array.isArray(r.body.files)).toBe(true);
  });
});
