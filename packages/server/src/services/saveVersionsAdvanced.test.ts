import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-saveversions-advanced-test-'));
process.env.API_KEY_SECRET = 'saveversions-advanced-test-secret-0123456789abcdef';

const { database } = await import('../db/index.js');
const { createVersionFromDirectory, restoreVersion, listSaveVersions } = await import('./saveVersions.js');
const { getGameRoot } = await import('../utils/path.js');
const { closeDbForTests } = await import('../db/sqlite.js');

const TMP = process.env.DATA_DIR as string;

afterAll(() => {
  closeDbForTests();
  delete process.env.DATA_DIR;
  delete process.env.API_KEY_SECRET;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('save version directory snapshots', () => {
  it('creates a version from a directory and restores it', () => {
    const game = database.upsertGame({ name: 'Snapshot Game', status: 'In Sync', lastSync: 'Never' });
    const gameRoot = getGameRoot(game.name);
    fs.mkdirSync(gameRoot, { recursive: true });
    fs.writeFileSync(path.join(gameRoot, 'slot.sav'), 'original');
    fs.mkdirSync(path.join(gameRoot, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(gameRoot, 'cache', 'shader.cache'), 'cache');

    const version = createVersionFromDirectory({
      gameId: game.id,
      gameName: game.name,
      changeSummary: 'snapshot',
    });

    expect(version.fileCount).toBe(1);
    expect(fs.existsSync(path.join(gameRoot, '.versions', version.id, 'slot.sav'))).toBe(true);

    fs.writeFileSync(path.join(gameRoot, 'slot.sav'), 'modified');
    const restore = restoreVersion(game.name, version.id);
    expect(restore.success).toBe(true);
    expect(restore.restoredFiles).toBe(1);
    expect(fs.readFileSync(path.join(gameRoot, 'slot.sav'), 'utf-8')).toBe('original');

    fs.rmSync(gameRoot, { recursive: true, force: true });
  });

  it('lists created versions', () => {
    const game = database.upsertGame({ name: 'List Game', status: 'In Sync', lastSync: 'Never' });
    const gameRoot = getGameRoot(game.name);
    fs.mkdirSync(gameRoot, { recursive: true });
    fs.writeFileSync(path.join(gameRoot, 'slot.sav'), 'data');
    createVersionFromDirectory({ gameId: game.id, gameName: game.name });
    expect(listSaveVersions(game.id).length).toBeGreaterThan(0);
    fs.rmSync(gameRoot, { recursive: true, force: true });
  });
});
