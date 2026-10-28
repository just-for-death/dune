import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { Readable } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Isolate ALL side effects BEFORE importing app modules (static imports hoist).
const SETUP_DATA_DIR = process.env.DATA_DIR as string; // temp dir from src/test/setup.ts (DUN-005)
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-sync-test-'));
process.env.API_KEY_SECRET = 'sync-test-secret-0123456789abcdef';

const { handleUploadFile, handleLocalSync } = await import('./sync.js');
const { getGameRoot } = await import('../utils/path.js');
const { database } = await import('../db/index.js');
const { getDb } = await import('../db/sqlite.js');
const { createSaveVersion } = await import('./saveVersions.js');
const { upsertBackupProfile } = await import('./backupProfiles.js');

const TMP = process.env.DATA_DIR as string;

const GAME_A = 'UploadLimitSizeGame';
const GAME_B = 'UploadLimitCountGame';
const OWNER = database.createUser(`sync-test-${Date.now()}`, 'admin').id;
/** saves/<owner>/<gameId> for a title (row created on demand, DUN-086). */
const rootOf = (title: string, owner = OWNER) => getGameRoot(database.ensureGame(owner, title).id, owner);

const OLD_MAX_MB = process.env.MAX_UPLOAD_MB;
const OLD_MAX_FILES = process.env.MAX_FILES_PER_GAME;

afterEach(() => {
  if (OLD_MAX_MB === undefined) delete process.env.MAX_UPLOAD_MB;
  else process.env.MAX_UPLOAD_MB = OLD_MAX_MB;
  if (OLD_MAX_FILES === undefined) delete process.env.MAX_FILES_PER_GAME;
  else process.env.MAX_FILES_PER_GAME = OLD_MAX_FILES;
  for (const g of [GAME_A, GAME_B]) {
    const dir = rootOf(g);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

afterAll(() => {
  process.env.DATA_DIR = SETUP_DATA_DIR; // restore the temp dir, never unset (DUN-005)
  delete process.env.API_KEY_SECRET;
  fs.rmSync(TMP, { recursive: true, force: true });
});

function streamOf(bytes: number): Readable {
  return Readable.from([Buffer.alloc(bytes, 'x')]);
}

describe('handleUploadFile limits', () => {
  it('rejects files exceeding MAX_UPLOAD_MB with 413 and no partial file', async () => {
    process.env.MAX_UPLOAD_MB = '1'; // 1 MB cap
    const res = await handleUploadFile(GAME_A, 'big.sav', streamOf(2 * 1024 * 1024), '1700000000000', OWNER);
    expect(res.success).toBe(false);
    expect(res.status).toBe(413);
    expect(res.message).toMatch(/exceeds/i);
    expect(fs.existsSync(path.join(rootOf(GAME_A), 'big.sav'))).toBe(false);
  });

  it('accepts files under the cap', async () => {
    process.env.MAX_UPLOAD_MB = '1';
    const res = await handleUploadFile(GAME_A, 'small.sav', streamOf(1024), '1700000000000', OWNER);
    expect(res.success).toBe(true);
    expect(fs.existsSync(path.join(rootOf(GAME_A), 'small.sav'))).toBe(true);
  });

  it('rejects new files when the game hits MAX_FILES_PER_GAME', async () => {
    process.env.MAX_FILES_PER_GAME = '2';
    const root = rootOf(GAME_B);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'a.sav'), 'a');
    fs.writeFileSync(path.join(root, 'b.sav'), 'b');

    const res = await handleUploadFile(GAME_B, 'c.sav', streamOf(10), '1700000000000', OWNER);
    expect(res.success).toBe(false);
    expect(res.status).toBe(413);
    expect(fs.existsSync(path.join(root, 'c.sav'))).toBe(false);
  });
});

describe('handleLocalSync', () => {
  it('syncs save folders from local sources and is idempotent', async () => {
    const src = path.join(TMP, 'win-mount', 'Hero Saves');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'slot1.sav'), 'hero-data');
    const added = database.addLocalSource(path.join(TMP, 'win-mount'));
    try {
      const first = await handleLocalSync(OWNER);
      expect(first.success).toBe(true);
      expect(first.count).toBeGreaterThanOrEqual(1);
      expect(first.games).toContain('Hero Saves');

      const second = await handleLocalSync(OWNER);
      expect(second.count).toBe(0);
    } finally {
      database.removeLocalSource(added.id);
      const dir = rootOf('Hero Saves');
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips missing sources without failing', async () => {
    const added = database.addLocalSource(path.join(TMP, 'does-not-exist'));
    try {
      const res = await handleLocalSync(OWNER);
      expect(res.success).toBe(true);
    } finally {
      database.removeLocalSource(added.id);
    }
  });
});

describe('handleUploadFile keeps child rows (DUN-085)', () => {
  const count = (table: string) =>
    Number((getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

  it('an upload does not drop save_versions / backup_profiles from 1 to 0', async () => {
    const owner = database.createUser(`dun085-${Date.now()}`, 'member');
    const seeded = database.ensureGame(owner.id, 'DUN085 Seeded');
    createSaveVersion({
      gameId: seeded.id,
      ownerId: owner.id,
      files: [{ path: 'slot.sav', size: 1, hash: 'h', mtime: '2026-01-01T00:00:00.000Z' }],
    });
    upsertBackupProfile({
      gameId: seeded.id,
      includeGlobs: ['**/*'],
      excludeGlobs: [],
      autoExcludeCache: true,
      updatedAt: new Date().toISOString(),
    });
    const versionsBefore = count('save_versions');
    const profilesBefore = count('backup_profiles');
    expect(versionsBefore).toBeGreaterThanOrEqual(1);
    expect(profilesBefore).toBeGreaterThanOrEqual(1);

    try {
      // Same game (update in place) and a different, brand-new game.
      for (const game of ['DUN085 Seeded', 'DUN085 Other', 'DUN085 Seeded']) {
        const res = await handleUploadFile(game, 'save.sav', streamOf(16), Date.now().toString(), owner.id);
        expect(res.success).toBe(true);
      }

      expect(count('save_versions')).toBe(versionsBefore);
      expect(count('backup_profiles')).toBe(profilesBefore);
      const row = database.getGames(owner.id).find(g => g.name === 'DUN085 Seeded');
      expect(row).toMatchObject({ id: seeded.id, status: 'In Sync' });
    } finally {
      for (const g of ['DUN085 Seeded', 'DUN085 Other']) {
        const dir = rootOf(g, owner.id);
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
