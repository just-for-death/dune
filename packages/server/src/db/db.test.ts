import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nextId } from '@dune/shared';

// Isolate ALL filesystem side effects (DB, secret) to a temp dir.
// Must precede the dynamic import below (static imports hoist).
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-db-test-'));
process.env.API_KEY_SECRET = 'db-test-secret-0123456789abcdef';

const { database, writeDB, withDbLock, closeDbForTests, runBootMigrations } = await import('../db/index.js');
const { hashApiKey } = await import('../utils/crypto.js');

const TMP = process.env.DATA_DIR as string;

function mkGame(name: string) {
  const ts = new Date().toISOString();
  return {
    id: nextId(),
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

describe('multi-user migration', () => {
  it('adds ownerId, creates one admin, adopts legacy keys, and claims games', () => {
    closeDbForTests();
    const dbFile = path.join(TMP, 'dune.sqlite');
    if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);

    // Build a pre-multi-user database: games without ownerId, hashed key in kv.
    const legacy = new DatabaseSync(dbFile);
    legacy.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE games (id REAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, status TEXT NOT NULL, lastSync TEXT NOT NULL, thumbnail TEXT NOT NULL DEFAULT '', analysis TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const ts = new Date().toISOString();
    legacy
      .prepare('INSERT INTO games (id, name, status, lastSync, thumbnail, analysis, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(1, 'Legacy Game', 'In Sync', 'Never', '', null, ts, ts);
    legacy
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?)')
      .run('settings', JSON.stringify({ apiKeys: [hashApiKey('legacy-key')] }));
    legacy.close();

    runBootMigrations();

    const games = database.getGames();
    const admin = database.listUsers().find(u => u.role === 'admin');
    expect(admin).toBeDefined();
    // Ownerless rows are claimed by the admin.
    expect(games.find(g => g.name === 'Legacy Game')?.ownerId).toBe(admin!.id);
    // The pre-existing hashed key now resolves to that admin.
    expect(database.resolveUserByKey('legacy-key')?.id).toBe(admin!.id);

    // Idempotent: re-running adds no second admin and no duplicate keys.
    runBootMigrations();
    expect(database.listUsers().filter(u => u.role === 'admin')).toHaveLength(1);
  });
});

describe('nextId', () => {
  it('mints integer ids that stay unique inside a single millisecond', () => {
    // Regression guard: `Date.now() + Math.random()` has only ~4096 distinct
    // values per millisecond (double ULP ≈ 2.4e-4 at that magnitude), so a
    // burst of ids collided and tripped `UNIQUE constraint failed: games.id`.
    const ids = Array.from({ length: 10000 }, () => nextId());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(Number.isInteger)).toBe(true);
    expect(ids.every((v, i) => i === 0 || v > ids[i - 1])).toBe(true);
  });
});
