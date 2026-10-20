import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-conflicts-test-'));
process.env.API_KEY_SECRET = 'conflicts-test-secret-0123456789abcdef';

const { database } = await import('../db/index.js');
const { createSaveVersion } = await import('./saveVersions.js');
const { detectConflict, resolveConflict, hasUnresolvedConflict, listConflicts } = await import('./conflicts.js');
const { closeDbForTests } = await import('../db/sqlite.js');

const TMP = process.env.DATA_DIR as string;

afterAll(() => {
  closeDbForTests();
  delete process.env.DATA_DIR;
  delete process.env.API_KEY_SECRET;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('conflicts service', () => {
  it('detects and resolves conflicts', () => {
    const game = database.upsertGame({ name: 'Conflict Game', status: 'In Sync', lastSync: 'Never' });
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
    const game = database.upsertGame({ name: 'Same Game', status: 'In Sync', lastSync: 'Never' });
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
});
