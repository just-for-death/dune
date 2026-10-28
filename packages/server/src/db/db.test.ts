import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nextId } from '@dune/shared';

// Isolate ALL filesystem side effects (DB, secret) to a temp dir.
// Must precede the dynamic import below (static imports hoist).
const SETUP_DATA_DIR = process.env.DATA_DIR as string; // temp dir from src/test/setup.ts (DUN-005)
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-db-test-'));
process.env.API_KEY_SECRET = 'db-test-secret-0123456789abcdef';

const { database, withDbLock, closeDbForTests, runBootMigrations } = await import('../db/index.js');
const { hashApiKey } = await import('../utils/crypto.js');
const sqlite = await import('./sqlite.js');

const TMP = process.env.DATA_DIR as string;
const OWNER = database.createUser(`db-owner-${Date.now()}`, 'member').id;

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
  process.env.DATA_DIR = SETUP_DATA_DIR; // restore the temp dir, never unset (DUN-005)
  delete process.env.API_KEY_SECRET;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('concurrent writes', () => {
  it('50 parallel locked read-modify-writes lose nothing', async () => {
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        withDbLock(() => {
          // DUN-085: per-row write by key (writeDB's bulk rewrite is gone).
          database.ensureGame(OWNER, `LockGame ${i}`);
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

describe('game rows: find/ensure/markGameSynced/rename (DUN-085/087/088)', () => {
  it('ensureGame finds case-insensitively; markGameSynced updates by id, keeping other fields', () => {
    const first = database.ensureGame(OWNER, 'Keyed Game');
    database.upsertGame({ name: 'Keyed Game', ownerId: OWNER, status: 'Pending Upload', lastSync: 'Never', thumbnail: 'http://art/k.png' });
    expect(database.ensureGame(OWNER, 'keyed game').id).toBe(first.id);
    expect(database.markGameSynced(first.id, '2021-01-01T00:00:00.000Z')).toBe(true);

    const rows = database.getGames(OWNER).filter(g => g.name.toLowerCase() === 'keyed game');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first.id, name: 'Keyed Game', status: 'In Sync',
      lastSync: '2021-01-01T00:00:00.000Z', updatedAt: '2021-01-01T00:00:00.000Z', thumbnail: 'http://art/k.png',
    });
  });

  it('scopes by owner: the same title for another owner is its own row, invisible to the first', () => {
    const other = database.createUser(`mgs-owner-${Date.now()}`, 'member');
    const mine = database.ensureGame(OWNER, 'Shared Title');
    const theirs = database.ensureGame(other.id, 'Shared Title');
    expect(theirs.id).not.toBe(mine.id);
    expect(database.findGame(other.id, 'shared title')?.id).toBe(theirs.id);
    expect(database.getGameByName('Shared Title', OWNER)?.id).toBe(mine.id);
    expect(database.getGames(other.id).map(g => g.name)).toEqual(['Shared Title']);
    expect(database.getOwnedGame(theirs.id, OWNER)).toBeUndefined();
    expect(database.deleteGame(theirs.id, OWNER)).toBe(false);
    expect(database.getGameById(theirs.id)).toBeDefined();
  });

  it('renameGame changes only the row, refuses clashes and other owners', () => {
    const a = database.ensureGame(OWNER, 'Rename Me');
    database.ensureGame(OWNER, 'Taken');
    expect(database.renameGame(a.id, OWNER, 'TAKEN')).toBe('conflict');
    expect(database.renameGame(a.id, 'usr_nobody', 'X')).toBe('not_found');
    expect(database.renameGame(a.id, OWNER, 'Renamed')).toBe('ok');
    expect(database.getGameById(a.id)?.name).toBe('Renamed');
  });
});

describe('upsertGame field preservation', () => {
  it('keeps analysis and thumbnail when a status-only update omits them', () => {
    const name = 'Preserve Game';
    database.upsertGame({
      name,
      ownerId: OWNER,
      status: 'In Sync',
      lastSync: '2020-01-01T00:00:00.000Z',
      thumbnail: 'http://art/cover.png',
      analysis: { 'slot1.sav': { category: 'Save', description: 'main save' } },
    });

    // A bare status update (what local sync issues) must not wipe them.
    database.upsertGame({ name, ownerId: OWNER, status: 'Pending Upload', lastSync: '2021-01-01T00:00:00.000Z' });

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

describe('unopenable database (DUN-099: fail loudly, never move aside)', () => {
  const dbFile = () => path.join(TMP, 'dune.sqlite');
  const snapshot = () => fs.readdirSync(TMP).sort();

  it('a corrupt file throws DatabaseOpenError on every call and is left byte-for-byte untouched', async () => {
    const { DatabaseOpenError } = await import('./sqlite.js');
    closeDbForTests();
    fs.writeFileSync(dbFile(), '{not valid sqlite{{{');
    const before = snapshot();
    expect(() => database.getGames()).toThrow(DatabaseOpenError);
    expect(() => database.getGames()).toThrow(/left untouched/);
    expect(() => runBootMigrations()).toThrow(DatabaseOpenError); // no fresh admin / bootstrap key
    expect(fs.readFileSync(dbFile(), 'utf-8')).toBe('{not valid sqlite{{{');
    expect(snapshot()).toEqual(before); // no .corrupt-*, no new DB, no .bootstrap-key
    fs.unlinkSync(dbFile());
    closeDbForTests();
  });

  it.skipIf(process.getuid?.() === 0)('an unreadable (EACCES) healthy DB throws and keeps its data', async () => {
    const { DatabaseOpenError } = await import('./sqlite.js');
    closeDbForTests();
    if (fs.existsSync(dbFile())) fs.unlinkSync(dbFile());
    database.ensureGame(database.createUser(`acc-${Date.now()}`, 'member').id, 'Keep Me');
    closeDbForTests();
    const bytes = fs.readFileSync(dbFile());
    fs.chmodSync(dbFile(), 0o000);
    try {
      expect(() => database.getGames()).toThrow(DatabaseOpenError);
      expect(fs.readdirSync(TMP).filter((e) => e.includes('.corrupt-'))).toEqual([]);
    } finally {
      fs.chmodSync(dbFile(), 0o600);
    }
    expect(Buffer.compare(fs.readFileSync(dbFile()), bytes)).toBe(0);
    closeDbForTests();
    expect(database.getGames().map((g) => g.name)).toContain('Keep Me');
  });
});

describe('multi-user boot (DUN-123: no legacy games rebuild)', () => {
  const dbFile = path.join(TMP, 'dune.sqlite');

  it('refuses a pre-multi-user games table without touching it (no rename/drop)', () => {
    closeDbForTests();
    if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
    const legacy = new DatabaseSync(dbFile);
    legacy.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE games (id REAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, status TEXT NOT NULL, lastSync TEXT NOT NULL, thumbnail TEXT NOT NULL DEFAULT '', analysis TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
    `);
    const ts = new Date().toISOString();
    legacy
      .prepare('INSERT INTO games (id, name, status, lastSync, thumbnail, analysis, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(1, 'Legacy Game', 'In Sync', 'Never', '', null, ts, ts);
    legacy.close();

    expect(() => database.getGames()).toThrow(sqlite.DatabaseOpenError);
    closeDbForTests();
    const check = new DatabaseSync(dbFile);
    const tables = (check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
    const rows = check.prepare('SELECT name FROM games').all() as Array<{ name: string }>;
    check.close();
    expect(tables).not.toContain('games_legacy');
    expect(rows.map((r) => r.name)).toEqual(['Legacy Game']);
    fs.unlinkSync(dbFile);
  });

  it('creates one admin, adopts hashed settings keys, and claims ownerless games', () => {
    closeDbForTests();
    if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
    database.getGames(); // fresh current-schema DB
    const { getDb } = sqlite;
    const ts = new Date().toISOString();
    getDb()
      .prepare('INSERT INTO games (id, name, status, lastSync, thumbnail, analysis, ownerId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)')
      .run(1, 'Ownerless Game', 'In Sync', 'Never', '', null, ts, ts);
    getDb().exec("DELETE FROM users");
    database.saveSettings({ ...database.getSettings(), apiKeys: [hashApiKey('legacy-key')] });

    runBootMigrations();

    const admin = database.listUsers().find(u => u.role === 'admin');
    expect(admin).toBeDefined();
    expect(database.getGames().find(g => g.name === 'Ownerless Game')?.ownerId).toBe(admin!.id);
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

describe('DUN-116: bootstrap key file always holds the live key', () => {
  it('replaces a stale .bootstrap-key with the newly generated key (0600, no temp left)', async () => {
    const { getDb } = await import('./sqlite.js');
    const keyFile = path.join(TMP, '.bootstrap-key');
    fs.writeFileSync(keyFile, 'stale-key-from-an-old-db', { mode: 0o644 });
    getDb().exec('DELETE FROM user_keys');

    runBootMigrations();

    const key = fs.readFileSync(keyFile, 'utf8');
    expect(key).not.toBe('stale-key-from-an-old-db');
    expect(database.resolveUserByKey(key)?.role).toBe('admin');
    expect(database.resolveUserByKey('stale-key-from-an-old-db')).toBeNull();
    if (process.platform !== 'win32') expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(TMP).filter((f) => f.startsWith('.bootstrap-key.'))).toEqual([]);
  });

  it('keeps no key file and no temp file when the data dir is not writable', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const { getDb } = await import('./sqlite.js');
    const keyFile = path.join(TMP, '.bootstrap-key');
    fs.rmSync(keyFile, { force: true });
    getDb().exec('DELETE FROM user_keys');
    fs.mkdirSync(keyFile); // a directory where the file goes: rename fails
    try {
      expect(() => runBootMigrations()).not.toThrow();
      expect(fs.statSync(keyFile).isDirectory()).toBe(true);
      expect(fs.readdirSync(TMP).filter((f) => f.startsWith('.bootstrap-key.'))).toEqual([]);
    } finally {
      fs.rmSync(keyFile, { recursive: true, force: true });
    }
  });
});
