import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SETUP_DATA_DIR = process.env.DATA_DIR as string; // temp dir from src/test/setup.ts (DUN-005)
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-saveversions-test-'));
process.env.API_KEY_SECRET = 'saveversions-test-secret-0123456789abcdef';

const { createSaveVersion, listSaveVersions, getSaveVersion, getVersionDiff } = await import('./saveVersions.js');
const { database } = await import('../db/index.js');
const OWNER = database.createUser(`owner-${Date.now()}`, 'member').id;
const { closeDbForTests } = await import('../db/sqlite.js');

const TMP = process.env.DATA_DIR as string;

afterAll(() => {
  closeDbForTests();
  process.env.DATA_DIR = SETUP_DATA_DIR; // restore the temp dir, never unset (DUN-005)
  delete process.env.API_KEY_SECRET;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('saveVersions service', () => {
  it('creates and lists versions', () => {
    const game = database.upsertGame({ name: 'Version Game', status: 'In Sync', lastSync: 'Never', ownerId: OWNER });
    const version = createSaveVersion({
      gameId: game.id,
      files: [{ path: 'slot1.sav', size: 10, hash: 'abc', mtime: '2026-01-01T00:00:00.000Z' }],
      changeSummary: 'initial',
    });

    expect(version.fileCount).toBe(1);
    expect(listSaveVersions(game.id)).toHaveLength(1);
  });

  it('returns version files and diffs', () => {
    const game = database.upsertGame({ name: 'Diff Game', status: 'In Sync', lastSync: 'Never', ownerId: OWNER });
    const v1 = createSaveVersion({
      gameId: game.id,
      files: [
        { path: 'a.sav', size: 1, hash: '1', mtime: '2026-01-01T00:00:00.000Z' },
        { path: 'b.sav', size: 2, hash: '2', mtime: '2026-01-01T00:00:00.000Z' },
      ],
    });
    const v2 = createSaveVersion({
      gameId: game.id,
      files: [
        { path: 'a.sav', size: 1, hash: '1', mtime: '2026-01-01T00:00:00.000Z' },
        { path: 'c.sav', size: 3, hash: '3', mtime: '2026-01-02T00:00:00.000Z' },
      ],
      parentVersionId: v1.id,
    });

    const detail = getSaveVersion(v2.id);
    expect(detail?.files).toHaveLength(2);

    const diff = getVersionDiff(v1.id, v2.id);
    expect(diff.added).toEqual(['c.sav']);
    expect(diff.removed).toEqual(['b.sav']);
    expect(diff.unchanged).toBe(1);
  });
});
