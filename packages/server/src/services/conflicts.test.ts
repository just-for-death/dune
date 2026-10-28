import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SETUP_DATA_DIR = process.env.DATA_DIR as string; // temp dir from src/test/setup.ts (DUN-005)
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-conflicts-test-'));
process.env.API_KEY_SECRET = 'conflicts-test-secret-0123456789abcdef';

const { database } = await import('../db/index.js');
const OWNER = database.createUser(`owner-${Date.now()}`, 'member').id;
const { createSaveVersion } = await import('./saveVersions.js');
const { detectConflict, resolveConflict, hasUnresolvedConflict, listConflicts } = await import('./conflicts.js');
const { closeDbForTests } = await import('../db/sqlite.js');

const TMP = process.env.DATA_DIR as string;

afterAll(() => {
  closeDbForTests();
  process.env.DATA_DIR = SETUP_DATA_DIR; // restore the temp dir, never unset (DUN-005)
  delete process.env.API_KEY_SECRET;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('conflicts service', () => {
  it('detects and resolves conflicts', () => {
    const game = database.upsertGame({ name: 'Conflict Game', status: 'In Sync', lastSync: 'Never', ownerId: OWNER });
    const v1 = createSaveVersion({
      gameId: game.id,
      files: [{ path: 'slot.sav', size: 10, hash: 'a', mtime: '2026-01-01T00:00:00.000Z' }],
    });
    const v2 = createSaveVersion({
      gameId: game.id,
      files: [{ path: 'slot.sav', size: 20, hash: 'b', mtime: '2026-01-02T00:00:00.000Z' }],
    });

    const conflict = detectConflict(game.id, v1.id, v2.id);
    expect(conflict).not.toBeNull();
    expect(hasUnresolvedConflict(game.id)).toBe(true);

    const resolved = resolveConflict(conflict!.id, 'both');
    expect(resolved?.resolution).toBe('both');
    expect(hasUnresolvedConflict(game.id)).toBe(false);
    expect(listConflicts(game.id)).toHaveLength(1);
  });

  it('does not create conflict for identical content', () => {
    const game = database.upsertGame({ name: 'Same Game', status: 'In Sync', lastSync: 'Never', ownerId: OWNER });
    const v1 = createSaveVersion({
      gameId: game.id,
      files: [{ path: 'slot.sav', size: 10, hash: 'same', mtime: '2026-01-01T00:00:00.000Z' }],
    });
    const v2 = createSaveVersion({
      gameId: game.id,
      files: [{ path: 'slot.sav', size: 10, hash: 'same', mtime: '2026-01-01T00:00:00.000Z' }],
    });

    expect(detectConflict(game.id, v1.id, v2.id)).toBeNull();
  });

  it('DUN-114: re-detecting the same pair (either order) reuses one record and keeps its resolution', () => {
    const game = database.upsertGame({ name: 'Dup Conflict Game', status: 'In Sync', lastSync: 'Never', ownerId: OWNER });
    const v1 = createSaveVersion({
      gameId: game.id,
      files: [{ path: 'slot.sav', size: 10, hash: 'x1', mtime: '2026-01-01T00:00:00.000Z' }],
    });
    const v2 = createSaveVersion({
      gameId: game.id,
      files: [{ path: 'slot.sav', size: 11, hash: 'x2', mtime: '2026-01-02T00:00:00.000Z' }],
    });
    const first = detectConflict(game.id, v1.id, v2.id);
    expect(first).not.toBeNull();
    expect(detectConflict(game.id, v1.id, v2.id)?.id).toBe(first!.id);
    expect(detectConflict(game.id, v2.id, v1.id)?.id).toBe(first!.id);
    expect(listConflicts(game.id)).toHaveLength(1);

    resolveConflict(first!.id, 'local');
    const again = detectConflict(game.id, v1.id, v2.id);
    expect(again).toMatchObject({ id: first!.id, resolution: 'local' });
    expect(hasUnresolvedConflict(game.id)).toBe(false);
    expect(listConflicts(game.id)).toHaveLength(1);
  });
});
