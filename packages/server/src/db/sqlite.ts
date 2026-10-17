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
      CREATE TABLE IF NOT EXISTS games (
        id REAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL,
        lastSync TEXT NOT NULL,
        thumbnail TEXT NOT NULL DEFAULT '',
        analysis TEXT,
        ownerId TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        role TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_keys (
        hash TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_user_keys_user ON user_keys(userId);
    `);
    ensureOwnerColumn(handle);
    // Safe only after ensureOwnerColumn: pre-multi-user DBs lack the column
    // until the ALTER runs.
    handle.exec('CREATE INDEX IF NOT EXISTS idx_games_owner ON games(ownerId);');
    return handle;
  } catch (err) {
    handle.close();
    throw err;
  }
}

/**
 * Pre-multi-user databases have `games` without an `ownerId` column. Add it
 * (nullable) so ownership can be backfilled. One-time: skipped once present.
 *
 * Game names stay globally unique on purpose — saves live at
 * `data/saves/<name>` and are not namespaced per user, so two users cannot own
 * a game with the same name.
 */
function ensureOwnerColumn(handle: DatabaseSync): void {
  const cols = handle.prepare('PRAGMA table_info(games)').all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === 'ownerId')) return;
  handle.exec('ALTER TABLE games ADD COLUMN ownerId TEXT;');
  logger.info('Migrated games table: added ownerId column');
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
      'INSERT OR IGNORE INTO games (id, name, status, lastSync, thumbnail, analysis, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const g of raw.games || []) {
      insertGame.run(
        g.id, g.name, g.status, g.lastSync, g.thumbnail || '',
        g.analysis ? JSON.stringify(g.analysis) : null,
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
