import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';

// Isolate ALL side effects BEFORE importing the app module
// (static imports hoist, so the app itself is imported dynamically).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-server-test-'));
process.env.DATA_DIR = TMP;
process.env.API_KEY_SECRET = 'server-test-secret-0123456789abcdef';

const { app } = await import('./server.js');
const { database } = await import('./db/index.js');

const AUTH_KEY = 'roundtrip-key-0123456789abcdef';
database.addApiKey(AUTH_KEY);

afterAll(() => {
  delete process.env.DATA_DIR;
  delete process.env.API_KEY_SECRET;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('liveness', () => {
  it('GET /health returns 200 without auth and without touching the DB', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.timestamp).toBe('string');
  });
});

describe('readiness', () => {
  it('GET /ready returns 200 with passing checks when data dir is writable', async () => {
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
    expect(res.body.checks.dataDir.ok).toBe(true);
    expect(res.body.checks.database.ok).toBe(true);
  });

  it('GET /ready returns 503 when the data dir is unusable', async () => {
    const blocker = path.join(TMP, 'blocker');
    fs.writeFileSync(blocker, 'x');
    process.env.DATA_DIR = blocker;
    try {
      const res = await request(app).get('/ready');
      expect(res.status).toBe(503);
      expect(res.body.ready).toBe(false);
      expect(res.body.checks.dataDir.ok).toBe(false);
    } finally {
      process.env.DATA_DIR = TMP;
      fs.unlinkSync(blocker);
    }
  });

  it('recovers to 200 after the data dir is usable again', async () => {
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
  });
});

describe('auth enforcement (regression guards)', () => {
  it('rejects REST file routes without a key', async () => {
    const res = await request(app).get('/api/download-file?game=x&path=y');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('rejects tRPC procedures without a key', async () => {
    const res = await request(app)
      .post('/trpc/sync.local')
      .set('Content-Type', 'application/json')
      .send({});
    expect(res.status).toBe(401);
  });

  it('keeps the tRPC health procedure public', async () => {
    const res = await request(app).get('/trpc/health?batch=1&input=%7B%220%22%3Anull%7D');
    expect(res.status).toBe(200);
  });
});

describe('save round-trip (upload → download → version)', () => {
  const game = 'RoundTrip';
  const v1 = Buffer.from('save-slot-1-version-one');
  const v2 = Buffer.from('save-slot-1-version-two-longer');

  const upload = (bytes: Buffer, file = 'slot1.sav') =>
    request(app)
      .post('/api/upload-file')
      .set('Content-Type', 'application/octet-stream')
      .set('x-api-key', AUTH_KEY)
      .set('x-game', game)
      .set('x-path', file)
      // syncId must be numeric: versions are stored under .versions/<syncId>
      // and listed by numeric directory name (client sends Date.now()).
      .set('x-sync-id', String(Date.now() + Math.floor(Math.random() * 1000)))
      .send(bytes);

  const trpcGet = (path: string, input: unknown) =>
    request(app)
      .get(`/trpc/${path}?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: input ?? null }))}`)
      .set('x-api-key', AUTH_KEY);

  it('uploads and downloads byte-identical content', async () => {
    const up = await upload(v1);
    expect(up.status).toBe(200);
    expect(up.body.success).toBe(true);

    const down = await request(app)
      .get(`/api/download-file?game=${game}&path=slot1.sav`)
      .set('x-api-key', AUTH_KEY)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(down.status).toBe(200);
    expect(Buffer.compare(down.body, v1)).toBe(0);
  });

  it('snapshots the previous version on overwrite and restores it', async () => {
    const up = await upload(v2);
    expect(up.body.success).toBe(true);

    const versions = await trpcGet('files.versions.list', { game });
    expect(versions.status).toBe(200);
    const list = versions.body[0].result.data.versions;
    expect(list.length).toBeGreaterThanOrEqual(1);
    const versionId = list[0].id as string;

    const old = await request(app)
      .get(`/api/download-version-file?game=${game}&versionId=${versionId}&path=slot1.sav`)
      .set('x-api-key', AUTH_KEY)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(old.status).toBe(200);
    expect(Buffer.compare(old.body, v1)).toBe(0);

    // …while current still serves the new bytes
    const cur = await request(app)
      .get(`/api/download-file?game=${game}&path=slot1.sav`)
      .set('x-api-key', AUTH_KEY)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(Buffer.compare(cur.body, v2)).toBe(0);
  });

  it('rejects oversize uploads with 413', async () => {
    const big = Buffer.alloc(1024);
    const up = await request(app)
      .post('/api/upload-file')
      .set('Content-Type', 'application/octet-stream')
      .set('x-api-key', AUTH_KEY)
      .set('x-game', game)
      .set('x-path', 'big.sav')
      .set('Content-Length', String(1024 * 1024 * 1024))
      .send(big);
    expect(up.status).toBe(413);
  });
});
