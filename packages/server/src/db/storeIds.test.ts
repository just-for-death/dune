// FEAT-server-storeIds: games.steamAppId / games.gogId migration and storage.
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Own temp DATA_DIR (never packages/server/data). Must precede the dynamic import.
const SETUP_DATA_DIR = process.env.DATA_DIR as string; // temp dir from src/test/setup.ts (DUN-005)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-storeids-db-test-'));
process.env.DATA_DIR = TMP;
process.env.API_KEY_SECRET = 'storeids-db-secret-0123456789abcdef';

const { database, closeDbForTests, runBootMigrations } = await import('./index.js');
const sqlite = await import('./sqlite.js');

const dbFile = path.join(TMP, 'dune.sqlite');

function columns(file: string): string[] {
  const h = new DatabaseSync(file);
  try {
    return (h.prepare('PRAGMA table_info(games)').all() as Array<{ name: string }>).map((c) => c.name);
  } finally {
    h.close();
  }
}

afterAll(() => {
  closeDbForTests();
  process.env.DATA_DIR = SETUP_DATA_DIR; // restore the temp dir, never unset (DUN-005)
  delete process.env.API_KEY_SECRET;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('migration: games.steamAppId / games.gogId', () => {
  it('a fresh DB has both nullable TEXT columns and the migration is a no-op', () => {
    closeDbForTests();
    if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
    const h = sqlite.getDb();
    const info = h.prepare('PRAGMA table_info(games)').all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown }>;
    for (const col of ['steamAppId', 'gogId']) {
      const c = info.find((i) => i.name === col);
      expect(c).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
    }
    expect(sqlite.migrateGamesStoreIds(h)).toEqual([]);
  });

  it('upgrades a pre-storeIds DB in place (rows kept, ids NULL); running twice is a no-op', () => {
    closeDbForTests();
    if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
    // The games/users schema exactly as shipped before FEAT-server-storeIds.
    const old = new DatabaseSync(dbFile);
    old.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, role TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE games (
        id REAL PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, lastSync TEXT NOT NULL,
        thumbnail TEXT NOT NULL DEFAULT '', analysis TEXT,
        ownerId TEXT REFERENCES users(id) ON DELETE SET NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(ownerId, name)
      );
    `);
    const ts = new Date().toISOString();
    old.prepare('INSERT INTO users (id, name, role, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)').run('u-old', 'old-admin', 'admin', ts, ts);
    old.prepare('INSERT INTO games (id, name, status, lastSync, thumbnail, analysis, ownerId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(42, 'Old Game', 'In Sync', ts, 'thumb.png', null, 'u-old', ts, ts);
    old.close();
    expect(columns(dbFile)).not.toContain('steamAppId');

    // Opening runs the guarded ALTERs; boot migrations still pass.
    expect(() => runBootMigrations()).not.toThrow();
    expect(columns(dbFile)).toEqual(expect.arrayContaining(['steamAppId', 'gogId']));
    const g = database.getGameById(42)!;
    expect(g).toMatchObject({ id: 42, name: 'Old Game', status: 'In Sync', thumbnail: 'thumb.png', ownerId: 'u-old', steamAppId: null, gogId: null });

    // Second run on the live handle and a full reopen: no-op, data intact.
    expect(sqlite.migrateGamesStoreIds(sqlite.getDb())).toEqual([]);
    const before = columns(dbFile);
    closeDbForTests();
    expect(() => runBootMigrations()).not.toThrow();
    expect(columns(dbFile)).toEqual(before);
    expect(before.filter((c) => c === 'steamAppId' || c === 'gogId')).toEqual(['steamAppId', 'gogId']);
    expect(database.getGameById(42)).toMatchObject({ name: 'Old Game', steamAppId: null, gogId: null });
  });

  it('adds only the column that is missing (partially upgraded DB)', () => {
    const h = new DatabaseSync(':memory:');
    h.exec("CREATE TABLE games (id REAL PRIMARY KEY, name TEXT NOT NULL, steamAppId TEXT)");
    expect(sqlite.migrateGamesStoreIds(h)).toEqual(['gogId']);
    expect(sqlite.migrateGamesStoreIds(h)).toEqual([]);
    h.close();
  });
});

describe('storage: ensureGame / upsertGame', () => {
  it('ensureGame stores ids on create, overwrites key by key, keeps absent keys, stays owner-scoped', () => {
    const a = database.createUser(`sid-a-${Date.now()}`, 'member').id;
    const b = database.createUser(`sid-b-${Date.now()}`, 'member').id;
    const created = database.ensureGame(a, 'Hollow Knight', { steamAppId: '367520' });
    expect(created).toMatchObject({ steamAppId: '367520', gogId: null });
    // Absent keys keep, given keys overwrite.
    expect(database.ensureGame(a, 'hollow knight', { gogId: '1308320804' })).toMatchObject({ id: created.id, steamAppId: '367520', gogId: '1308320804' });
    expect(database.ensureGame(a, 'Hollow Knight')).toMatchObject({ steamAppId: '367520', gogId: '1308320804' });
    expect(database.ensureGame(a, 'Hollow Knight', { steamAppId: '620' })).toMatchObject({ steamAppId: '620', gogId: '1308320804' });
    // Same title for another owner: separate row, untouched by owner a's ids.
    const other = database.ensureGame(b, 'Hollow Knight');
    expect(other.id).not.toBe(created.id);
    expect(other).toMatchObject({ steamAppId: null, gogId: null });
    expect(database.getGameById(created.id)).toMatchObject({ steamAppId: '620', gogId: '1308320804' });
  });

  it('upsertGame stores ids on create and preserves stored ids on a status update', () => {
    const owner = database.createUser(`sid-u-${Date.now()}`, 'member').id;
    const g = database.upsertGame({ name: 'Celeste', status: 'In Sync', lastSync: 'Never', ownerId: owner, gogId: '1955430409' });
    expect(g).toMatchObject({ steamAppId: null, gogId: '1955430409' });
    database.upsertGame({ name: 'Celeste', status: 'Pending Upload', lastSync: 'Never', ownerId: owner });
    expect(database.getGameById(g.id)).toMatchObject({ status: 'Pending Upload', gogId: '1955430409', steamAppId: null });
  });
});
