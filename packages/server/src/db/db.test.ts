import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Isolate ALL filesystem side effects (DB, secret) to a temp dir.
// Must precede the dynamic import below (static imports hoist).
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-db-test-'));
process.env.API_KEY_SECRET = 'db-test-secret-0123456789abcdef';

const { database, writeDB, withDbLock, closeDbForTests } = await import('../db/index.js');

const TMP = process.env.DATA_DIR as string;

function mkGame(name: string) {
  const ts = new Date().toISOString();
  return {
    id: Date.now() + Math.random(),
    name,
    winPath: '',
    linPath: '',
    lastSync: ts,
    status: 'In Sync' as const,
    thumbnail: '',
    createdAt: ts,
    updatedAt: ts,
  };
}

afterAll(() => {
  closeDbForTests();
  delete process.env.DATA_DIR;
  delete process.env.API_KEY_SECRET;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('concurrent writes', () => {
  it('50 parallel locked read-modify-writes lose nothing', async () => {
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        withDbLock(() => {
          const games = database.getGames();
          games.push(mkGame(`LockGame ${i}`));
          writeDB({ games, settings: database.getSettings() });
        }),
      ),
    );

    const games = database.getGames();
    expect(games.filter(g => g.name.startsWith('LockGame '))).toHaveLength(50);

    // SQLite file on disk holds all entries (re-open from a fresh handle
    // would see the same rows — verified here via row count through the API
    // plus file existence).
    expect(fs.existsSync(path.join(TMP, 'dune.sqlite'))).toBe(true);
  });

  it('withDbLock propagates errors but keeps the lock usable', async () => {
    await expect(withDbLock(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    const v = await withDbLock(() => 42);
    expect(v).toBe(42);
  });
});

describe('upsertGame field preservation', () => {
  it('keeps analysis and thumbnail when a status-only update omits them', () => {
    const name = 'Preserve Game';
    database.upsertGame({
      name,
      status: 'In Sync',
      lastSync: '2020-01-01T00:00:00.000Z',
      thumbnail: 'http://art/cover.png',
      analysis: { 'slot1.sav': { category: 'Save', description: 'main save' } },
    });

    // A bare status update (what local sync issues) must not wipe them.
    database.upsertGame({ name, status: 'Pending Upload', lastSync: '2021-01-01T00:00:00.000Z' });

    const after = database.getGames().find(g => g.name === name);
    expect(after?.thumbnail).toBe('http://art/cover.png');
    expect(after?.analysis).toMatchObject({ 'slot1.sav': { category: 'Save' } });
  });
});

describe('legacy JSON migration', () => {
  it('imports dune.json once and renames it to a .migrated backup', async () => {
    closeDbForTests();
    const legacyGames = [mkGame('Migrated Game')];
    fs.writeFileSync(
      path.join(TMP, 'dune.json'),
      JSON.stringify({ games: legacyGames, settings: { maxVersions: 3 } }),
    );
    if (fs.existsSync(path.join(TMP, 'dune.sqlite'))) {
      fs.unlinkSync(path.join(TMP, 'dune.sqlite'));
    }

    expect(database.getGames().map(g => g.name)).toContain('Migrated Game');
    expect(database.getSettings().maxVersions).toBe(3);
    expect(fs.existsSync(path.join(TMP, 'dune.json'))).toBe(false);
    const backups = fs.readdirSync(TMP).filter(e => /^dune\.json\.migrated-\d+$/.test(e));
    expect(backups).toHaveLength(1);
    expect(database.getGames().map(g => g.name)).toContain('Migrated Game');
  });
});

describe('corrupt database recovery', () => {
  it('quarantines the corrupt file and boots with defaults', () => {
    closeDbForTests();
    const dbFile = path.join(TMP, 'dune.sqlite');
    fs.writeFileSync(dbFile, '{not valid sqlite{{{');

    const games = database.getGames();
    expect(games).toEqual([]);

    const entries = fs.readdirSync(TMP);
    const backups = entries.filter(e => /^dune\.sqlite\.corrupt-\d+$/.test(e));
    expect(backups).toHaveLength(1);
    // Quarantine holds the same garbage (rename, not copy)
    expect(fs.readFileSync(path.join(TMP, backups[0]), 'utf-8')).toBe('{not valid sqlite{{{');
    // A fresh database file was created in its place
    expect(fs.existsSync(dbFile)).toBe(true);
  });
});
