import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';

/**
 * Practical app-conditions suite.
 * Mimics what the Electron client + deploy stack actually do:
 * boot probes → auth → local-sync from a fake mount → REST
 * upload/download → REST lists → overwrite/version restore →
 * adversarial inputs → corrupt-DB recovery → new-module wiring.
 */

// Isolate ALL side effects BEFORE importing app modules.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-appcond-'));
const SETUP_DATA_DIR = process.env.DATA_DIR as string; // temp dir from src/test/setup.ts (DUN-005)
process.env.DATA_DIR = TMP;
process.env.API_KEY_SECRET = 'appcond-secret-0123456789abcdef';
process.env.DUNE_CONFIG_DIR = path.join(TMP, 'config');

const { app } = await import('./server.js');
const { database } = await import('./db/index.js');

// DUN-039: the snapshot download route is gone (no caller); read the
// snapshot straight from its validated path instead.
const { resolveGameFile } = await import('./utils/path.js');
function snapshotBytes(title: string, versionId: string, rel: string): Buffer {
  const g = database.getGames().find((x) => x.name === title);
  if (!g) throw new Error(`no game ${title}`);
  return fs.readFileSync(resolveGameFile(g.id, `.versions/${versionId}/${rel}`, g.ownerId).abs);
}

// DUN-110: database.addApiKey (test-only) is gone; issue a real admin key.
const AUTH_KEY = database.issueUserKey(database.listUsers().find((u) => u.role === 'admin')!.id, 'test admin key');

const api = (req: request.Test) => req.set('x-api-key', AUTH_KEY);

function downloadBuffer(url: string) {
  return api(request(app).get(url))
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
}

function uploadBytes(game: string, file: string, bytes: Buffer, syncId = String(Date.now())) {
  return api(
    request(app)
      .post('/api/upload-file')
      .set('Content-Type', 'application/octet-stream')
      .set('x-game', game)
      .set('x-path', file)
      .set('x-sync-id', syncId),
  ).send(bytes);
}

afterAll(() => {
  process.env.DATA_DIR = SETUP_DATA_DIR; // restore the temp dir, never unset (DUN-005)
  delete process.env.API_KEY_SECRET;
  delete process.env.DUNE_CONFIG_DIR;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('A. boot probes (compose healthcheck conditions)', () => {
  it('GET /health is public and dependency-free', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /ready passes when the data dir is writable', async () => {
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
  });
});

describe('B. auth conditions (misconfigured client)', () => {
  it('REST rejects missing key with 401', async () => {
    const res = await request(app).get('/api/download-file?game=x&path=y');
    expect(res.status).toBe(401);
  });

  it('REST rejects wrong key with 403', async () => {
    const res = await request(app)
      .get('/api/download-file?game=x&path=y')
      .set('x-api-key', 'wrong-key');
    expect(res.status).toBe(403);
  });

  it('REST rejects unauthenticated local-sync with 401', async () => {
    const res = await request(app).post('/api/local-sync').send({});
    expect(res.status).toBe(401);
  });
});

describe('C. full game lifecycle (client app flow)', () => {
  const game = 'Practical Quest';
  const mount = path.join(TMP, 'win-mount');
  const gameSrc = path.join(mount, game);
  const v1 = Buffer.from('practical-save-v1');
  const v2 = Buffer.from('practical-save-v2-longer');
  let sourceId = -1;

  it('local-sync picks up a fresh mount like autodetect would', async () => {
    fs.mkdirSync(gameSrc, { recursive: true });
    fs.writeFileSync(path.join(gameSrc, 'slot1.sav'), v1);
    const added = database.addLocalSource(mount);
    sourceId = added.id;

    const res = await api(request(app).post('/api/local-sync'));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.games).toContain(game);
  });

  it('uploads a new file and downloads byte-identical bytes', async () => {
    const up = await uploadBytes(game, 'manual.sav', v1);
    expect(up.status).toBe(200);
    expect(up.body.success).toBe(true);

    const down = await downloadBuffer(`/api/download-file?game=${encodeURIComponent(game)}&path=manual.sav`);
    expect(down.status).toBe(200);
    expect(Buffer.compare(down.body, v1)).toBe(0);
  });

  it('list-files reflects what upload stored', async () => {
    const res = await api(request(app).get('/api/list-files').query({ game }));
    expect(res.status).toBe(200);
    const files = res.body.files as Array<{ path: string }>;
    const paths = files.map((f) => f.path);
    expect(paths).toContain('slot1.sav');
    expect(paths).toContain('manual.sav');
  });

  it('overwrite snapshots the old version and it restores', async () => {
    // DUN-097: the overwrite's sync id names its snapshot dir .versions/<syncId>.
    const syncId = String(Date.now());
    const up = await uploadBytes(game, 'slot1.sav', v2, syncId);
    expect(up.body.success).toBe(true);

    expect(Buffer.compare(snapshotBytes(game, syncId, 'slot1.sav'), v1)).toBe(0);

    const cur = await downloadBuffer(`/api/download-file?game=${encodeURIComponent(game)}&path=slot1.sav`);
    expect(Buffer.compare(cur.body, v2)).toBe(0);
  });

  it('game status lands in sync in the DB', async () => {
    const games = database.getGames();
    const entry = games.find((g) => g.name === game);
    expect(entry).toBeDefined();
    expect(entry?.status).toBe('In Sync');
    if (sourceId !== -1) database.removeLocalSource(sourceId);
  });
});

describe('D. adversarial app conditions', () => {
  it('blocks path traversal on download', async () => {
    const res = await api(
      request(app).get('/api/download-file?game=x&path=' + encodeURIComponent('../../etc/passwd')),
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'DOT_SEGMENT' });
  });

  it('DUN-039: the callerless snapshot download route is gone (404 NOT_FOUND)', async () => {
    const res = await api(
      request(app).get('/api/download-version-file?game=x&versionId=1&path=y'),
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found', code: 'NOT_FOUND' });
  });

  it('rejects missing upload headers with 400', async () => {
    const res = await api(
      request(app).post('/api/upload-file').set('Content-Type', 'application/octet-stream'),
    ).send(Buffer.from('x'));
    expect(res.status).toBe(400);
  });

  it('rejects absurd content-length with 413', async () => {
    const res = await request(app)
      .post('/api/upload-file')
      .set('Content-Type', 'application/octet-stream')
      .set('x-api-key', AUTH_KEY)
      .set('x-game', 'Practical Quest')
      .set('x-path', 'big.sav')
      .set('Content-Length', String(1024 * 1024 * 1024))
      .send(Buffer.from('x'));
    expect(res.status).toBe(413);
  });

  it('refuses a corrupt DB: requests fail, /ready is 503, the file is untouched (DUN-099)', async () => {
    const { closeDbForTests } = await import('./db/index.js');
    closeDbForTests();
    const dbFile = path.join(TMP, 'dune.sqlite');
    const saved = fs.existsSync(dbFile) ? fs.readFileSync(dbFile) : null;
    try {
      fs.writeFileSync(dbFile, '{corrupt-sqlite!!!');
      expect(() => database.getGames()).toThrow(/left untouched/);
      const ready = await request(app).get('/ready');
      expect(ready.status).toBe(503);
      expect(ready.body.checks.database.ok).toBe(false);
      expect(fs.readFileSync(dbFile, 'utf-8')).toBe('{corrupt-sqlite!!!');
      expect(fs.readdirSync(TMP).filter((f) => f.startsWith('dune.sqlite.corrupt-'))).toEqual([]);
    } finally {
      closeDbForTests();
      if (saved) fs.writeFileSync(dbFile, saved);
      else fs.rmSync(dbFile, { force: true });
    }
  });
});
