import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { logger } from '../middleware/logging.js';
import { dataDir } from '../utils/path.js';
import type { Game, Settings } from '../types/index.js';

function sqlitePath(): string {
  return path.join(dataDir(), 'dune.sqlite');
}

function legacyJsonPath(): string {
  return path.join(dataDir(), 'dune.json');
}

let db: DatabaseSync | null = null;

/**
 * Open (creating + migrating on first run) the SQLite database.
 * Single-file rollback-journal mode on purpose: the data dir is backed up
 * with plain tar, which cannot capture WAL sidecar files consistently.
 * deploy.sh documents stopping the server for guaranteed-consistent backups.
 */
export function getDb(): DatabaseSync {
  if (db) return db;
  const file = sqlitePath();
  const fresh = !fs.existsSync(file);
  try {
    db = openSchema(file);
  } catch (err) {
    // Corrupt / unreadable file: quarantine it exactly like jsonStore does
    // for corrupt JSON, then boot empty. Never delete user data silently.
    try {
      const backup = `${file}.corrupt-${Date.now()}`;
      fs.renameSync(file, backup);
      logger.error({ err, file, backup }, 'dune.sqlite: corrupt DB preserved, booting with defaults');
    } catch (copyErr) {
      logger.error({ err: copyErr, file }, 'dune.sqlite: corrupt DB could not be preserved');
    }
    db = openSchema(file);
  }
  if (fresh) {
    migrateLegacyJson();
  }
  return db;
}

function openSchema(file: string): DatabaseSync {
  const handle = new DatabaseSync(file);
  try {
    handle.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        role TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_keys (
        hash TEXT PRIMARY KEY,
        userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        description TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS games (
        id REAL PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        lastSync TEXT NOT NULL,
        thumbnail TEXT NOT NULL DEFAULT '',
        analysis TEXT,
        ownerId TEXT REFERENCES users(id) ON DELETE SET NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(ownerId, name)
      );
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_user_keys_user ON user_keys(userId);
    `);
    ensureOwnerColumn(handle);
    // Safe only after ensureOwnerColumn: pre-multi-user DBs lack the column
    // until the ALTER runs.
    handle.exec('CREATE INDEX IF NOT EXISTS idx_games_owner ON games(ownerId);');
    // DUN-087/088: a game is identified by (owner, title) case-insensitively;
    // enforce it so two rows can never map to the same lookup. (SQLite NOCASE
    // folds ASCII letters only.) Saves live under the game id, not the title.
    handle.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_games_owner_name_nocase ON games(ownerId, name COLLATE NOCASE);');

    // Save versioning (Dune)
    handle.exec(`
      CREATE TABLE IF NOT EXISTS save_versions (
        id TEXT PRIMARY KEY,
        gameId REAL NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        ownerId TEXT REFERENCES users(id) ON DELETE SET NULL,
        deviceId TEXT,
        createdAt TEXT NOT NULL,
        sizeBytes REAL NOT NULL DEFAULT 0,
        fileCount INTEGER NOT NULL DEFAULT 0,
        parentVersionId TEXT,
        changeSummary TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'complete'
      );
      CREATE TABLE IF NOT EXISTS save_file_snapshots (
        id TEXT PRIMARY KEY,
        versionId TEXT NOT NULL REFERENCES save_versions(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        size REAL NOT NULL DEFAULT 0,
        hash TEXT NOT NULL,
        mtime TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conflict_records (
        id TEXT PRIMARY KEY,
        gameId REAL NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        localVersionId TEXT NOT NULL,
        remoteVersionId TEXT NOT NULL,
        detectedAt TEXT NOT NULL,
        resolution TEXT,
        resolvedAt TEXT
      );
      CREATE TABLE IF NOT EXISTS backup_profiles (
        gameId REAL PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
        includeGlobs TEXT NOT NULL DEFAULT '[]',
        excludeGlobs TEXT NOT NULL DEFAULT '[]',
        autoExcludeCache INTEGER NOT NULL DEFAULT 1,
        maxFileSizeMB REAL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        ownerId TEXT REFERENCES users(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        lastSeen TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_save_versions_game ON save_versions(gameId);
      CREATE INDEX IF NOT EXISTS idx_save_snapshots_version ON save_file_snapshots(versionId);
      CREATE INDEX IF NOT EXISTS idx_conflicts_game ON conflict_records(gameId);
    `);
    return handle;
  } catch (err) {
    handle.close();
    throw err;
  }
}

/**
 * Pre-multi-user databases have `games` without an `ownerId` column, and
 * pre-namespacing databases have a *global* `UNIQUE(name)`. Rebuild the table
 * so `ownerId` exists and uniqueness is per-owner (allowing two users to own
 * a game with the same title once saves are namespaced by owner). One-time:
 * skipped once the composite unique constraint is present.
 */
function ensureOwnerColumn(handle: DatabaseSync): void {
  const row = handle.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'games'").get() as { sql: string } | undefined;
  if (row && row.sql && row.sql.includes('UNIQUE(ownerId, name)')) return;

  const cols = handle.prepare('PRAGMA table_info(games)').all() as Array<{ name: string }>;
  const hasOwner = cols.some((c) => c.name === 'ownerId');
  const ownerSelect = hasOwner ? 'ownerId' : 'NULL';

  handle.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE games RENAME TO games_legacy;
    CREATE TABLE games (
      id REAL PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      lastSync TEXT NOT NULL,
      thumbnail TEXT NOT NULL DEFAULT '',
      analysis TEXT,
      ownerId TEXT REFERENCES users(id) ON DELETE SET NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      UNIQUE(ownerId, name)
    );
    INSERT INTO games (id, name, status, lastSync, thumbnail, analysis, ownerId, createdAt, updatedAt)
      SELECT id, name, status, lastSync, thumbnail, analysis, ${ownerSelect}, createdAt, updatedAt FROM games_legacy;
    DROP TABLE games_legacy;
    COMMIT;
  `);
  logger.info('Migrated games table: ownerId + per-owner unique name + FK');
}

/** One-way import from the pre-SQLite dune.json. Never deletes the original. */
function migrateLegacyJson(): void {
  const legacy = legacyJsonPath();
  if (!fs.existsSync(legacy)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(legacy, 'utf-8')) as {
      games?: Game[];
      settings?: Settings;
    };
    const database = getDb();
    const insertGame = database.prepare(
      'INSERT OR IGNORE INTO games (id, name, status, lastSync, thumbnail, analysis, ownerId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const g of raw.games || []) {
      insertGame.run(
        g.id, g.name, g.status, g.lastSync, g.thumbnail || '',
        g.analysis ? JSON.stringify(g.analysis) : null,
        null, // legacy games have no owner
        g.createdAt, g.updatedAt,
      );
    }
    if (raw.settings) {
      database
        .prepare('INSERT OR IGNORE INTO kv (key, value) VALUES (?, ?)')
        .run('settings', JSON.stringify(raw.settings));
    }
    const backup = `${legacy}.migrated-${Date.now()}`;
    fs.renameSync(legacy, backup);
    logger.info('Migrated legacy dune.json to SQLite');
  } catch (err) {
    // Corrupt legacy file: quarantine it exactly like jsonStore does, boot empty.
    try {
      const backup = `${legacy}.corrupt-${Date.now()}`;
      fs.copyFileSync(legacy, backup);
      logger.error({ err, file: legacy, backup }, 'dune.json: corrupt legacy DB preserved, booting with defaults');
    } catch (copyErr) {
      logger.error({ err: copyErr, file: legacy }, 'dune.json: corrupt legacy DB could not be preserved');
    }
  }
}

/** Test-only hook: close + forget the handle so temp DATA_DIRs clean up. */
export function closeDbForTests(): void {
  if (db) {
    db.close();
    db = null;
  }
}
