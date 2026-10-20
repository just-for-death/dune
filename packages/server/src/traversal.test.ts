import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import request from 'supertest';

// DUN-086/087/088/093/111/125/061/064/127, end to end over REST and tRPC.
// Saves live at saves/<ownerId>/<gameId>; titles never reach the filesystem.
// Everything lives in a temp DATA_DIR; sentinels sit next to (outside) saves/.
const SETUP_DATA_DIR = process.env.DATA_DIR as string; // temp dir from src/test/setup.ts (DUN-005)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-traversal-test-'));
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-traversal-outside-'));
process.env.DATA_DIR = TMP;
process.env.API_KEY_SECRET = 'traversal-secret-0123456789abcdef';

const { app } = await import('./server.js');
const { database } = await import('./db/index.js');
const { getDb } = await import('./db/sqlite.js');
const { getGameRoot, savesDir } = await import('./utils/path.js');
const { handleUploadFile } = await import('./services/sync.js');

const ADMIN_KEY = 'traversal-admin-key-0123456789';
database.addApiKey(ADMIN_KEY, 'traversal admin');

interface Member { id: string; key: string }
let alice: Member;
let bob: Member;

const DATA_SENTINEL = path.join(TMP, 'sentinel.txt');
const OUTSIDE_SENTINEL = path.join(OUTSIDE, 'outside.txt');

function member(name: string): Member {
  const u = database.createUser(name, 'member');
  return { id: u.id, key: database.issueUserKey(u.id, 'traversal test') };
}

/** Desktop's contract (DUN-064/127): x-game / x-path are encodeURIComponent'd. */
function upload(key: string, game: string, file: string, body = 'DATA') {
  return uploadRaw(key, encodeURIComponent(game), encodeURIComponent(file), body);
}
function uploadRaw(key: string, gameHeader: string, pathHeader: string, body = 'DATA') {
  return request(app)
    .post('/api/upload-file')
    .set('x-api-key', key)
    .set('x-game', gameHeader)
    .set('x-path', pathHeader)
    .set('x-sync-id', Date.now().toString())
    .set('Content-Type', 'application/octet-stream')
    .send(Buffer.from(body));
}

const restDelete = (key: string, game: string, p: string) =>
  request(app).delete('/api/file').set('x-api-key', key).query({ game, path: p });
const restDownload = (key: string, game: string, p: string) =>
  request(app).get('/api/download-file').set('x-api-key', key).query({ game, path: p });
const restList = (key: string, game: string) =>
  request(app).get('/api/list-files').set('x-api-key', key).query({ game });
const trpcRemove = (key: string, game: string, p: string) =>
  request(app).post('/trpc/files.remove').set('x-api-key', key).send({ game, path: p });
const trpcAdd = (key: string, input: Record<string, unknown>) =>
  request(app).post('/trpc/games.add').set('x-api-key', key).send(input);
/** tRPC structured code (errorFormatter): error.data.code. */
const trpcCode = (res: request.Response) => res.body?.error?.data?.code;

const gameOf = (owner: Member, title: string) => database.findGame(owner.id, title)!;
const rootOf = (owner: Member, title: string) => getGameRoot(gameOf(owner, title).id, owner.id);

/** Every file under saves/ plus both sentinels, with contents. */
function fsState(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) out[full] = `-> ${fs.readlinkSync(full)}`;
      else if (e.isDirectory()) walk(full);
      else out[full] = fs.readFileSync(full, 'utf-8');
    }
  };
  walk(savesDir());
  out[DATA_SENTINEL] = fs.readFileSync(DATA_SENTINEL, 'utf-8');
  out[OUTSIDE_SENTINEL] = fs.readFileSync(OUTSIDE_SENTINEL, 'utf-8');
  return out;
}

let bobFile: string;

beforeAll(async () => {
  fs.writeFileSync(DATA_SENTINEL, 'DATA-SENTINEL');
  fs.writeFileSync(OUTSIDE_SENTINEL, 'OUTSIDE-SENTINEL');
  alice = member('traversal-alice');
  bob = member('traversal-bob');
  expect((await upload(alice.key, 'Hades', 'Saves/slot1.sav', 'ALICE')).body.success).toBe(true);
  expect((await upload(bob.key, 'Bob Game', 'Saves/slot2.sav', 'BOB')).body.success).toBe(true);
  bobFile = path.join(rootOf(bob, 'Bob Game'), 'Saves', 'slot2.sav');
  expect(fs.readFileSync(bobFile, 'utf-8')).toBe('BOB');
});

afterAll(() => {
  process.env.DATA_DIR = SETUP_DATA_DIR; // restore the temp dir, never unset (DUN-005)
  delete process.env.API_KEY_SECRET;
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
});

describe('DUN-086: traversal on DELETE /api/file and tRPC files.remove', () => {
  const evilPaths = (): Array<[string, string]> => [
    ['../../../sentinel.txt', 'DOT_SEGMENT'],
    [`../../${bob.id}/${gameOf(bob, 'Bob Game').id}/Saves/slot2.sav`, 'DOT_SEGMENT'],
    ['Saves/../../../../sentinel.txt', 'DOT_SEGMENT'],
    ['..\\..\\..\\sentinel.txt', 'DOT_SEGMENT'],
    [DATA_SENTINEL, 'ABSOLUTE'],
    ['/etc/x', 'ABSOLUTE'],
    ['C:\\x', 'ABSOLUTE'],
    ['C:/x', 'ABSOLUTE'],
    ['\\\\server\\x', 'ABSOLUTE'],
    ['\\x', 'ABSOLUTE'],
    ['Saves/slot1.sav\0', 'NUL'],
  ];

  it('REST: every evil path gets 400 exactly { error, code } and nothing is deleted', async () => {
    for (const [p, code] of evilPaths()) {
      const before = fsState();
      const res = await restDelete(alice.key, 'Hades', p);
      expect(res.status, p).toBe(400);
      expect(res.body, p).toEqual({ code, error: expect.any(String) });
      expect(fsState(), p).toEqual(before);
    }
    expect((await restDelete(alice.key, 'Hades', '')).status).toBe(400); // missing param
  });

  it('tRPC: every evil path gets BAD_REQUEST with data.code and nothing is deleted', async () => {
    for (const [p, code] of [...evilPaths(), ['', 'EMPTY'] as [string, string]]) {
      const before = fsState();
      const res = await trpcRemove(alice.key, 'Hades', p);
      expect(res.status, p).toBe(400);
      expect(trpcCode(res), p).toBe(code);
      expect(fsState(), p).toEqual(before);
    }
  });

  it('a URL-encoded ..%2F query path is decoded once by the router and rejected; double-encoded stays a literal name', async () => {
    const before = fsState();
    const once = await request(app)
      .delete('/api/file?game=Hades&path=..%2F..%2F..%2Fsentinel.txt')
      .set('x-api-key', alice.key);
    expect(once.status).toBe(400);
    expect(once.body.code).toBe('DOT_SEGMENT');
    const twice = await request(app)
      .delete('/api/file?game=Hades&path=..%252F..%252F..%252Fsentinel.txt')
      .set('x-api-key', alice.key);
    expect(twice.status).toBe(404); // literal file name "..%2F..%2F..%2Fsentinel.txt" inside the root: absent
    expect(fsState()).toEqual(before);
  });

  it('cross-user: A cannot delete B\'s file by traversal or by B\'s game name (REST + tRPC); B\'s file survives', async () => {
    const bobGame = gameOf(bob, 'Bob Game');
    const traversal = `../../${bob.id}/${bobGame.id}/Saves/slot2.sav`;
    const byTraversal = [
      await restDelete(alice.key, 'Hades', traversal),
      await trpcRemove(alice.key, 'Hades', traversal),
    ];
    for (const res of byTraversal) {
      expect(res.status).toBe(400);
      expect(res.body.code ?? trpcCode(res)).toBe('DOT_SEGMENT');
    }
    // By B's title: resolves in A's namespace only -> A has no such game.
    const byName = [
      await restDelete(alice.key, 'Bob Game', 'Saves/slot2.sav'),
      await trpcRemove(alice.key, 'Bob Game', 'Saves/slot2.sav'),
      await restDelete(alice.key, 'bob game', 'Saves/slot2.sav'),
    ];
    for (const res of byName) {
      expect(res.status).toBe(404);
      expect(res.body.code ?? trpcCode(res)).toBe('GAME_NOT_FOUND');
    }
    // By explicit owner: members may not target another owner.
    const targeted = await request(app).delete('/api/file').set('x-api-key', alice.key)
      .query({ game: 'Bob Game', path: 'Saves/slot2.sav', owner: bob.id });
    expect(targeted.status).toBe(403);
    // Download by B's name is 404 too, never B's bytes.
    const dl = await restDownload(alice.key, 'Bob Game', 'Saves/slot2.sav');
    expect(dl.status).toBe(404);
    expect(JSON.stringify(dl.body)).not.toContain('BOB');
    expect(fs.readFileSync(bobFile, 'utf-8')).toBe('BOB');
  });

  it('legit nested path Saves/slot1.sav still downloads and deletes (REST), and tRPC deletes', async () => {
    const dl = await restDownload(alice.key, 'Hades', 'Saves/slot1.sav').buffer(true);
    expect(dl.status).toBe(200);
    expect(dl.body.toString()).toBe('ALICE');
    const del = await restDelete(alice.key, 'Hades', 'Saves\\slot1.sav');
    expect(del.status).toBe(200);
    expect(fs.existsSync(path.join(rootOf(alice, 'Hades'), 'Saves', 'slot1.sav'))).toBe(false);

    expect((await upload(alice.key, 'Hades', 'Saves/slot1.sav', 'ALICE')).body.success).toBe(true);
    const t = await trpcRemove(alice.key, 'Hades', 'Saves/slot1.sav');
    expect(t.status).toBe(200);
    expect((await upload(alice.key, 'Hades', 'Saves/slot1.sav', 'ALICE')).body.success).toBe(true);
  });
});

describe('symlinks inside the save root pointing outside', () => {
  let root: string;
  beforeAll(() => {
    root = rootOf(alice, 'Hades');
    fs.symlinkSync(OUTSIDE, path.join(root, 'linkdir'));
    fs.symlinkSync(OUTSIDE_SENTINEL, path.join(root, 'link.sav'));
  });

  it('delete via a symlinked dir or file is rejected (REST + tRPC) and the target is unchanged', async () => {
    for (const p of ['linkdir/outside.txt', 'link.sav']) {
      const before = fsState();
      const r = await restDelete(alice.key, 'Hades', p);
      expect(r.status, p).toBe(400);
      expect(r.body.code).toBe('OUTSIDE_ROOT');
      const t = await trpcRemove(alice.key, 'Hades', p);
      expect(t.status, p).toBe(400);
      expect(trpcCode(t)).toBe('OUTSIDE_ROOT');
      expect(fsState()).toEqual(before);
    }
    expect(fs.readFileSync(OUTSIDE_SENTINEL, 'utf-8')).toBe('OUTSIDE-SENTINEL');
  });

  it('download via a symlink is rejected and nothing outside is served', async () => {
    for (const p of ['linkdir/outside.txt', 'link.sav']) {
      const r = await restDownload(alice.key, 'Hades', p);
      expect(r.status, p).toBe(400);
      expect(r.body.code).toBe('OUTSIDE_ROOT');
      expect(JSON.stringify(r.body)).not.toContain('OUTSIDE-SENTINEL');
    }
  });

  it('upload through a symlink is rejected and the outside target is unchanged', async () => {
    for (const p of ['linkdir/outside.txt', 'linkdir/new.sav', 'link.sav']) {
      const r = await upload(alice.key, 'Hades', p, 'PWNED');
      expect(r.status, p).toBe(400);
      expect(r.body.code).toBe('OUTSIDE_ROOT');
    }
    expect(fs.readFileSync(OUTSIDE_SENTINEL, 'utf-8')).toBe('OUTSIDE-SENTINEL');
    expect(fs.readdirSync(OUTSIDE)).toEqual(['outside.txt']);
  });

  it('upload into a game whose id folder is a symlink to outside is rejected', async () => {
    const linked = database.ensureGame(alice.id, 'Linked Game');
    const linkedRoot = path.join(path.dirname(root), String(linked.id));
    fs.symlinkSync(OUTSIDE, linkedRoot);
    try {
      const r = await upload(alice.key, 'Linked Game', 'x.sav', 'PWNED');
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('OUTSIDE_ROOT');
      expect(fs.readdirSync(OUTSIDE)).toEqual(['outside.txt']);
    } finally {
      fs.unlinkSync(linkedRoot);
    }
  });
});

describe('DUN-093: game titles never reach the filesystem', () => {
  it.each(['.', '..', '...', 'a/b', 'a\\b', '../../../etc', `../x`])(
    'title %j is just a title: stored as-is, files land only in saves/<owner>/<gameId>',
    async (name) => {
      const before = fsState();
      const res = await upload(alice.key, name, 'evil.sav', 'EVIL');
      expect(res.status).toBe(200);
      const row = gameOf(alice, name);
      expect(row.name).toBe(name);
      const target = path.join(savesDir(), alice.id, String(row.id), 'evil.sav');
      expect(fs.readFileSync(target, 'utf-8')).toBe('EVIL');
      const after = fsState();
      const added = Object.keys(after).filter((k) => !(k in before));
      expect(added).toEqual([target]);
      for (const k of Object.keys(before)) expect(after[k], k).toBe(before[k]);
    },
  );

  it.each([
    ['', 'EMPTY'],
    ['   ', 'EMPTY'],
    ['a\0b', 'NUL'],
    ['a\u0001b', 'CONTROL'],
    ['a\u007fb', 'CONTROL'],
    ['x'.repeat(201), 'TOO_LONG'],
  ])('REST upload / tRPC games.add with title %j gets 400 %s and creates no row', async (name, code) => {
    const before = fsState();
    const rows = database.getGames(alice.id).length;
    const up = await upload(alice.key, name, 'evil.sav', 'EVIL');
    expect(up.status).toBe(400);
    if (name !== '') expect(up.body).toEqual({ code, error: expect.any(String) });
    const add = await trpcAdd(alice.key, { name });
    expect(add.status).toBe(400);
    if (name !== '') expect(trpcCode(add)).toBe(code);
    expect(database.getGames(alice.id).length).toBe(rows);
    expect(fsState()).toEqual(before);
  });

  it('NUL / control characters in a game query param are a 400 on REST (download, delete, list)', async () => {
    for (const game of ['a\0b', 'a\u0001b']) {
      expect((await restDelete(alice.key, game, 'x.sav')).status).toBe(400);
      expect((await restDownload(alice.key, game, 'x.sav')).status).toBe(400);
      expect((await restList(alice.key, game)).status).toBe(400);
    }
  });

  it('a rejected path never creates a phantom game row', async () => {
    const rows = database.getGames(alice.id).length;
    expect((await upload(alice.key, 'Phantom', '../x.sav')).status).toBe(400);
    expect(database.getGames(alice.id).length).toBe(rows);
  });

  it('admin DELETE /api/saves removes only saves/<owner>/<gameId>, never saves/<owner>', async () => {
    expect((await upload(alice.key, 'Doomed', 'Saves/a.sav', 'D')).body.success).toBe(true);
    const doomed = gameOf(alice, 'Doomed');
    const doomedRoot = getGameRoot(doomed.id, alice.id);
    const hadesRoot = rootOf(alice, 'Hades');
    const res = await request(app).delete('/api/saves').set('x-api-key', ADMIN_KEY).query({ id: doomed.id });
    expect(res.status).toBe(200);
    expect(fs.existsSync(doomedRoot)).toBe(false);
    expect(fs.existsSync(path.dirname(doomedRoot))).toBe(true);
    expect(fs.existsSync(path.join(hadesRoot, 'Saves', 'slot1.sav'))).toBe(true);
    expect(fs.readFileSync(bobFile, 'utf-8')).toBe('BOB');
    expect(fs.readFileSync(DATA_SENTINEL, 'utf-8')).toBe('DATA-SENTINEL');
  });

  it('admin DELETE /api/saves by title is scoped to the admin unless owner= is given', async () => {
    const notMine = await request(app).delete('/api/saves').set('x-api-key', ADMIN_KEY).query({ game: 'Bob Game' });
    expect(notMine.status).toBe(404);
    expect(fs.readFileSync(bobFile, 'utf-8')).toBe('BOB');
    const bad = await request(app).delete('/api/saves').set('x-api-key', ADMIN_KEY).query({ id: '../1' });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'Invalid id', code: 'INVALID_GAME_ID' });
  });

  it('admin DELETE /api/saves on a "." title removes only that game\'s id folder', async () => {
    const dot = gameOf(alice, '.');
    const before = fsState();
    const res = await request(app).delete('/api/saves').set('x-api-key', ADMIN_KEY).query({ id: dot.id });
    expect(res.status).toBe(200);
    const after = fsState();
    const removed = Object.keys(before).filter((k) => !(k in after));
    expect(removed).toEqual([path.join(savesDir(), alice.id, String(dot.id), 'evil.sav')]);
    expect(database.findGame(alice.id, '.')).toBeUndefined();
  });
});

describe('real titles sync end to end (DUN-064/127 encoded headers)', () => {
  it.each([
    ['The Witcher 3: Wild Hunt', 'Saves/QuickSave.sav'],
    ['DARK SOULS™ III', 'Saves/DS30000.sl2'],
    ['大神', 'セーブ/slot1.sav'],
  ])('%j uploads via encoded headers, lists, downloads and deletes over REST', async (title, file) => {
    const up = await upload(alice.key, title, file, `BYTES:${title}`);
    expect(up.status).toBe(200);
    const row = gameOf(alice, title);
    expect(row.name).toBe(title);
    // Folder is the id, never the title.
    expect(fs.existsSync(path.join(getGameRoot(row.id, alice.id), ...file.split('/')))).toBe(true);
    const list = await restList(alice.key, title);
    expect(list.body.files.map((f: { path: string }) => f.path)).toContain(file);
    const dl = await restDownload(alice.key, title, file).buffer(true);
    expect(dl.body.toString()).toBe(`BYTES:${title}`);
    expect((await restDelete(alice.key, title, file)).status).toBe(200);
  });

  it('a raw (unencoded) ASCII header still works: decoding plain text is a no-op', async () => {
    const r = await uploadRaw(alice.key, 'Hades', 'Saves/plain.sav', 'PLAIN');
    expect(r.status).toBe(200);
    expect(fs.readFileSync(path.join(rootOf(alice, 'Hades'), 'Saves', 'plain.sav'), 'utf-8')).toBe('PLAIN');
  });

  it('malformed percent-encoding in x-game or x-path is 400 INVALID_HEADER_ENCODING and writes nothing', async () => {
    const before = fsState();
    const rows = database.getGames(alice.id).length;
    for (const [g, p] of [['%E0%A4%A', 'x.sav'], ['Hades', '%E0%A4%A'], ['%', 'x.sav'], ['Hades', 'a%ZZ']]) {
      const r = await uploadRaw(alice.key, g, p);
      expect(r.status, `${g} ${p}`).toBe(400);
      expect(r.body).toEqual({ code: 'INVALID_HEADER_ENCODING', error: expect.any(String) });
    }
    expect(database.getGames(alice.id).length).toBe(rows);
    expect(fsState()).toEqual(before);
  });

  it('a double-encoded ..%252F is decoded once: a literal name, not traversal', async () => {
    const before = fsState();
    // x-path: '..%252F..%252Fsentinel.txt' -> literal file '..%2F..%2Fsentinel.txt' in the root.
    const p = await uploadRaw(alice.key, 'Hades', '..%252F..%252Fsentinel.txt', 'LITERAL');
    expect(p.status).toBe(200);
    expect(fs.readFileSync(path.join(rootOf(alice, 'Hades'), '..%2F..%2Fsentinel.txt'), 'utf-8')).toBe('LITERAL');
    // x-game: '..%252F' -> literal title '..%2F'.
    const g = await uploadRaw(alice.key, '..%252F', 'x.sav', 'LITERAL');
    expect(g.status).toBe(200);
    expect(gameOf(alice, '..%2F').name).toBe('..%2F');
    // Single-encoded ../ in x-path IS traversal after the one decode: rejected.
    const once = await uploadRaw(alice.key, 'Hades', '..%2F..%2Fsentinel.txt', 'PWNED');
    expect(once.status).toBe(400);
    expect(once.body.code).toBe('DOT_SEGMENT');
    expect(fs.readFileSync(DATA_SENTINEL, 'utf-8')).toBe('DATA-SENTINEL');
    expect(fsState()[DATA_SENTINEL]).toBe(before[DATA_SENTINEL]);
  });

  it('titles match case-insensitively per owner: "HADES" is the same game, same folder', async () => {
    const r = await upload(alice.key, 'HADES', 'Saves/case.sav', 'CASE');
    expect(r.status).toBe(200);
    expect(fs.existsSync(path.join(rootOf(alice, 'Hades'), 'Saves', 'case.sav'))).toBe(true);
    expect(database.getGames(alice.id).filter((g) => g.name.toLowerCase() === 'hades')).toHaveLength(1);
  });

  it('renaming a game leaves its files in place (folder = id)', async () => {
    expect((await upload(alice.key, 'Old Name', 'Saves/keep.sav', 'KEEP')).status).toBe(200);
    const row = gameOf(alice, 'Old Name');
    const rootBefore = getGameRoot(row.id, alice.id);
    const ren = await request(app).post('/trpc/games.rename').set('x-api-key', alice.key)
      .send({ id: row.id, name: 'New Name: Remastered™' });
    expect(ren.status).toBe(200);
    expect(rootOf(alice, 'New Name: Remastered™')).toBe(rootBefore);
    expect(fs.readFileSync(path.join(rootBefore, 'Saves', 'keep.sav'), 'utf-8')).toBe('KEEP');
    const dl = await restDownload(alice.key, 'New Name: Remastered™', 'Saves/keep.sav').buffer(true);
    expect(dl.body.toString()).toBe('KEEP');
    expect((await restList(alice.key, 'Old Name')).body.files).toEqual([]);
    // Bob cannot rename Alice's game.
    const steal = await request(app).post('/trpc/games.rename').set('x-api-key', bob.key).send({ id: row.id, name: 'Mine' });
    expect(steal.status).toBe(404);
  });
});

describe('DUN-061: launch fields are rejected at intake and never stored', () => {
  it.each([
    ['executable', '/usr/bin/evil'],
    ['args', ['--x']],
    ['env', { LD_PRELOAD: '/tmp/x.so' }],
    ['cwd', '/tmp'],
    ['winePrefix', '/tmp/pfx'],
    ['protonVersion', '9'],
    ['launchOptions', '%command%'],
    ['emulatorPath', '/x'],
    ['customExecutable', '/x'],
  ])('tRPC games.add with %s is 400 LAUNCH_FIELD_NOT_ALLOWED and creates no row', async (field, value) => {
    const rows = database.getGames(alice.id).length;
    const res = await trpcAdd(alice.key, { name: `Launch ${field}`, [field]: value });
    expect(res.status).toBe(400);
    expect(trpcCode(res)).toBe('LAUNCH_FIELD_NOT_ALLOWED');
    expect(database.getGames(alice.id).length).toBe(rows);
  });

  it('unknown non-launch keys are rejected too (strict schema), so nothing slips through', async () => {
    const res = await trpcAdd(alice.key, { name: 'Strict', winPath: 'C:/Games/x.exe' });
    expect(res.status).toBe(400);
    expect(database.findGame(alice.id, 'Strict')).toBeUndefined();
  });

  it('REST bodies with launch fields are 400 { error, code }', async () => {
    for (const [route, body] of [
      ['/api/save-versions', { game: 'Hades', executable: '/x' }],
      ['/api/restore-version', { game: 'Hades', versionId: '1', env: { A: '1' } }],
      ['/api/backup-profile', { game: 'Hades', launchArgs: '-x' }],
      ['/api/analyze-files-ai', { gameName: 'Hades', files: [], cwd: '/tmp' }],
    ] as const) {
      const res = await request(app).post(route).set('x-api-key', alice.key).send(body);
      expect(res.status, route).toBe(400);
      expect(res.body, route).toEqual({ code: 'LAUNCH_FIELD_NOT_ALLOWED', error: expect.any(String) });
    }
  });

  it('the games table has no launch columns and listings carry none', async () => {
    const cols = (getDb().prepare('PRAGMA table_info(games)').all() as Array<{ name: string }>).map((c) => c.name);
    const { isLaunchField } = await import('./utils/apiError.js');
    expect(cols.filter(isLaunchField)).toEqual([]);
    const listed = await request(app).get('/api/saves').set('x-api-key', alice.key);
    for (const g of listed.body.games) expect(Object.keys(g).filter(isLaunchField)).toEqual([]);
  });
});

describe('DUN-111 / DUN-125', () => {
  it('handleUploadFile returns a 400 result (no throw) for a rejected path or name', async () => {
    const bad = await handleUploadFile('Hades', '../x.sav', Readable.from([Buffer.from('x')]), '1', alice.id);
    expect(bad).toMatchObject({ success: false, status: 400 });
    const badName = await handleUploadFile('a\0b', 'x.sav', Readable.from([Buffer.from('x')]), '1', alice.id);
    expect(badName).toMatchObject({ success: false, status: 400 });
  });

  it('REST upload with a traversal x-path is a 400 with a code, not a 500', async () => {
    const res = await upload(alice.key, 'Hades', '../../../sentinel.txt', 'PWNED');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ code: 'DOT_SEGMENT', error: expect.any(String) });
    expect(fs.readFileSync(DATA_SENTINEL, 'utf-8')).toBe('DATA-SENTINEL');
  });

  it('files.list / sync.manifest with a bad title are 400, not 500 (DUN-128)', async () => {
    for (const proc of ['files.list', 'sync.manifest']) {
      const input = encodeURIComponent(JSON.stringify({ game: 'a\u0001b' }));
      const res = await request(app).get(`/trpc/${proc}?input=${input}`).set('x-api-key', alice.key);
      expect(res.status, proc).toBe(400);
      expect(trpcCode(res), proc).toBe('CONTROL');
    }
  });

  it('restore-version: malformed ids are 400 INVALID_VERSION_ID (REST) without touching the filesystem', async () => {
    const before = fsState();
    for (const versionId of ['../../..', '..', '1/../../x', 'not-a-uuid', '123']) {
      const res = await request(app).post('/api/restore-version').set('x-api-key', alice.key).send({ game: 'Hades', versionId });
      expect(res.status, versionId).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid version id', code: 'INVALID_VERSION_ID' });
    }
    expect(fsState()).toEqual(before);
  });

  it('restore-version: another user\'s version id is 404, never restored', async () => {
    const created = await request(app).post('/api/save-versions').set('x-api-key', bob.key).send({ game: 'Bob Game' });
    expect(created.status).toBe(201);
    const res = await request(app).post('/api/restore-version').set('x-api-key', alice.key)
      .send({ game: 'Hades', versionId: created.body.version.id });
    expect(res.status).toBe(404);
    const detail = await request(app).get(`/api/save-versions/${created.body.version.id}`).set('x-api-key', alice.key);
    expect(detail.status).toBe(404);
  });

  it('restore does not follow a symlink inside a snapshot (DUN-128)', async () => {
    const created = await request(app).post('/api/save-versions').set('x-api-key', alice.key).send({ game: 'Hades' });
    expect(created.status).toBe(201);
    const id = created.body.version.id as string;
    const snap = path.join(rootOf(alice, 'Hades'), '.versions', id);
    fs.symlinkSync(OUTSIDE_SENTINEL, path.join(snap, 'stolen.sav'));
    const res = await request(app).post('/api/restore-version').set('x-api-key', alice.key).send({ game: 'Hades', versionId: id });
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(rootOf(alice, 'Hades'), 'stolen.sav'))).toBe(false);
    expect(fs.readFileSync(OUTSIDE_SENTINEL, 'utf-8')).toBe('OUTSIDE-SENTINEL');
  });

  it('tRPC files.versions.files rejects malformed version ids with data.code INVALID_VERSION_ID', async () => {
    for (const versionId of ['../..', '1/../../x', 'abc']) {
      const input = encodeURIComponent(JSON.stringify({ game: 'Hades', versionId }));
      const res = await request(app).get(`/trpc/files.versions.files?input=${input}`).set('x-api-key', alice.key);
      expect(res.status, versionId).toBe(400);
      expect(trpcCode(res), versionId).toBe('INVALID_VERSION_ID');
    }
  });

  it('REST download-version-file: malformed id 400 INVALID_VERSION_ID; snapshot path traversal 400', async () => {
    const bad = await request(app).get('/api/download-version-file').set('x-api-key', alice.key)
      .query({ game: 'Hades', versionId: '..', path: 'x' });
    expect(bad.body).toEqual({ error: 'Invalid version id', code: 'INVALID_VERSION_ID' });
    const trav = await request(app).get('/api/download-version-file').set('x-api-key', alice.key)
      .query({ game: 'Hades', versionId: '123', path: '../../../sentinel.txt' });
    expect(trav.status).toBe(400);
    expect(trav.body.code).toBe('DOT_SEGMENT');
  });
});
