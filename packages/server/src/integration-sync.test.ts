import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-integration-sync-test-'));
process.env.DATA_DIR = TMP;
process.env.API_KEY_SECRET = 'integration-secret-0123456789abcdef';

const { app } = await import('./server.js');
const { database } = await import('./db/index.js');

const AUTH_KEY = 'integration-test-auth-key-01234';
database.addApiKey(AUTH_KEY, 'Integration test key');

afterAll(() => {
  delete process.env.DATA_DIR;
  delete process.env.API_KEY_SECRET;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('Integration: Full Client-Server Save Sync Lifecycle', () => {
  const gameName = 'EldenRing';
  const saveContentV1 = Buffer.from('ELDEN_RING_SAVE_VERSION_1_DATA_BINARY_BYTES');
  const saveContentV2 = Buffer.from('ELDEN_RING_SAVE_VERSION_2_UPDATED_PROGRESS');
  const configContent = Buffer.from('[Graphics]\nResolution=1920x1080\nFullscreen=true\n');
  const syncId1 = '1729000000001';
  const syncId2 = '1729000000002';

  const trpcGet = (procPath: string, input: unknown) =>
    request(app)
      .get(`/trpc/${procPath}?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: input ?? null }))}`)
      .set('x-api-key', AUTH_KEY);

  it('step 1: uploads initial save and config files via REST upload-file', async () => {
    // Upload save file
    const res1 = await request(app)
      .post('/api/upload-file')
      .set('x-api-key', AUTH_KEY)
      .set('x-game', gameName)
      .set('x-path', 'saves/slot1.sav')
      .set('x-sync-id', syncId1)
      .set('Content-Type', 'application/octet-stream')
      .send(saveContentV1);

    expect(res1.status).toBe(200);
    expect(res1.body.success).toBe(true);

    // Upload config file
    const res2 = await request(app)
      .post('/api/upload-file')
      .set('x-api-key', AUTH_KEY)
      .set('x-game', gameName)
      .set('x-path', 'config/settings.ini')
      .set('x-sync-id', syncId1)
      .set('Content-Type', 'application/octet-stream')
      .send(configContent);

    expect(res2.status).toBe(200);
    expect(res2.body.success).toBe(true);
  });

  it('step 2: lists files and correctly categorizes save vs config', async () => {
    const res = await request(app)
      .get(`/api/list-files?game=${encodeURIComponent(gameName)}`)
      .set('x-api-key', AUTH_KEY);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.files).toHaveLength(2);

    const saveFile = res.body.files.find((f: { path: string }) => f.path === 'saves/slot1.sav');
    expect(saveFile).toBeDefined();
    expect(saveFile.category).toBe('Save');
    expect(saveFile.size).toBe(saveContentV1.length);

    const configFile = res.body.files.find((f: { path: string }) => f.path === 'config/settings.ini');
    expect(configFile).toBeDefined();
    expect(configFile.category).toBe('Config');
    expect(configFile.size).toBe(configContent.length);
  });

  it('step 3: creates a version snapshot on overwrite', async () => {
    // Overwrite slot1.sav with V2 data under a second syncId
    const res = await request(app)
      .post('/api/upload-file')
      .set('x-api-key', AUTH_KEY)
      .set('x-game', gameName)
      .set('x-path', 'saves/slot1.sav')
      .set('x-sync-id', syncId2)
      .set('Content-Type', 'application/octet-stream')
      .send(saveContentV2);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // List versions via tRPC files.versions.list
    const verRes = await trpcGet('files.versions.list', { game: gameName });
    expect(verRes.status).toBe(200);
    const versions = verRes.body[0].result.data.versions;
    expect(versions.length).toBeGreaterThanOrEqual(1);
    expect(versions.some((v: { id: string }) => v.id === syncId2)).toBe(true);
  });

  it('step 4: downloads active version and verifies exact byte identity', async () => {
    const res = await request(app)
      .get(`/api/download-file?game=${encodeURIComponent(gameName)}&path=${encodeURIComponent('saves/slot1.sav')}`)
      .set('x-api-key', AUTH_KEY)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body, saveContentV2)).toBe(0);
  });

  it('step 5: downloads archived version snapshot and verifies original bytes', async () => {
    const res = await request(app)
      .get(`/api/download-version-file?game=${encodeURIComponent(gameName)}&versionId=${syncId2}&path=${encodeURIComponent('saves/slot1.sav')}`)
      .set('x-api-key', AUTH_KEY)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body, saveContentV1)).toBe(0);
  });

  it('step 6: performs local-sync scan and handles sources correctly', async () => {
    const localSyncRes = await request(app)
      .post('/api/local-sync')
      .set('x-api-key', AUTH_KEY);

    expect(localSyncRes.status).toBe(200);
    expect(localSyncRes.body.success).toBe(true);
    expect(Array.isArray(localSyncRes.body.games)).toBe(true);
  });
});
