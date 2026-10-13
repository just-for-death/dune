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
