import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-integration-sync-test-'));
const SETUP_DATA_DIR = process.env.DATA_DIR as string; // temp dir from src/test/setup.ts (DUN-005)
process.env.DATA_DIR = TMP;
process.env.API_KEY_SECRET = 'integration-secret-0123456789abcdef';

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
const AUTH_KEY = database.issueUserKey(database.listUsers().find((u) => u.role === 'admin')!.id, 'Integration test key');

afterAll(() => {
  process.env.DATA_DIR = SETUP_DATA_DIR; // restore the temp dir, never unset (DUN-005)
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
    // The snapshot dir is named by the sync id (.versions/<syncId2>); step 5
    // downloads the archived bytes from it over REST.
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

  it('step 5: the archived version snapshot holds the original bytes', () => {
    expect(Buffer.compare(snapshotBytes(gameName, syncId2, 'saves/slot1.sav'), saveContentV1)).toBe(0);
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
