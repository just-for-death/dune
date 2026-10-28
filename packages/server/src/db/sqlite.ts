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

/** DUN-099: the database exists but can't be opened. Never recovered automatically. */
export class DatabaseOpenError extends Error {
  readonly file: string;
  readonly dbCode: string;
  constructor(file: string, dbCode: string, reason: string, cause: unknown) {
    super(`Cannot open ${file} (${dbCode}): ${reason}. The file was left untouched; fix the cause or restore a backup, then restart.`, { cause });
    this.name = 'DatabaseOpenError';
    this.file = file;
    this.dbCode = dbCode;
  }
}

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
    // DUN-099: fail loudly. Never rename, copy over, delete or re-create the
    // file: a BUSY/EACCES/IO error on a healthy DB must not turn into an empty
    // database with a fresh admin and bootstrap key. The operator fixes the
    // cause (or restores a backup) and restarts.
    db = null;
    const code = (err as { code?: unknown; errcode?: unknown }).errcode ?? (err as { code?: unknown }).code;
    const reason = err instanceof Error ? err.message : String(err);
    logger.fatal({ err, file }, 'dune.sqlite could not be opened; refusing to start (file left untouched)');
    throw new DatabaseOpenError(file, String(code ?? 'UNKNOWN'), reason, err);
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
        steamAppId TEXT,
        gogId TEXT,
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
    // DUN-123: no legacy games-table rebuild (no-compat ruling). A
    // pre-multi-user DB has no ownerId, so this index fails and getDb throws
    // DatabaseOpenError without touching the file, instead of a rename/drop
    // that would cascade-wipe child tables.
    handle.exec('CREATE INDEX IF NOT EXISTS idx_games_owner ON games(ownerId);');
    // DUN-087/088: a game is identified by (owner, title) case-insensitively;
    // enforce it so two rows can never map to the same lookup. (SQLite NOCASE
    // folds ASCII letters only.) Saves live under the game id, not the title.
    handle.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_games_owner_name_nocase ON games(ownerId, name COLLATE NOCASE);');
    // FEAT-server-storeIds: a DB created before these columns gets them here
    // (fresh DBs already have them from CREATE TABLE above).
    migrateGamesStoreIds(handle);

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
      -- DUN-100: local-sync folder (full normalized path) -> game, per owner.
      CREATE TABLE IF NOT EXISTS local_sync_games (
        ownerId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sourcePath TEXT NOT NULL,
        gameId REAL NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        PRIMARY KEY (ownerId, sourcePath)
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

/** Nullable columns added to `games` after its first schema (FEAT-server-storeIds). */
export const GAMES_STORE_ID_COLUMNS = ['steamAppId', 'gogId'] as const;

/**
 * FEAT-server-storeIds: add the nullable Steam/GOG id columns to `games`.
 * Every ALTER TABLE ... ADD COLUMN is guarded by PRAGMA table_info, so a
 * fresh DB, an existing DB and a second run all end with the same schema and
 * existing rows keep their data (new columns read NULL). Returns the columns
 * it added (empty = nothing to do).
 */
export function migrateGamesStoreIds(handle: DatabaseSync): string[] {
  const have = new Set(
    (handle.prepare('PRAGMA table_info(games)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  const added: string[] = [];
  for (const col of GAMES_STORE_ID_COLUMNS) {
    if (have.has(col)) continue;
    handle.exec(`ALTER TABLE games ADD COLUMN ${col} TEXT`);
    added.push(col);
  }
  if (added.length > 0) logger.info({ columns: added }, 'Added store id columns to games');
  return added;
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

/**
 * Run `fn` inside one IMMEDIATE transaction on the shared handle: commit on
 * return, roll back on throw (DUN-098). Not re-entrant; callers keep their
 * transactional work synchronous.
 */
export function inTransaction<T>(fn: (handle: DatabaseSync) => T): T {
  const handle = getDb();
  handle.exec('BEGIN IMMEDIATE');
  try {
    const out = fn(handle);
    handle.exec('COMMIT');
    return out;
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
}

/** Test-only hook: close + forget the handle so temp DATA_DIRs clean up. */
export function closeDbForTests(): void {
  if (db) {
    db.close();
    db = null;
  }
}
