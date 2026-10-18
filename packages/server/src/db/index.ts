import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { nextId } from '@dune/shared';
import type {
  Game,
  Settings,
  LocalSource,
  RemoteServer,
  User,
  UserRole,
  ApiKeyRecord,
} from '../types/index.js';
import { hashApiKey, looksHashed, matchStoredHash } from '../utils/crypto.js';
import { logger } from '../middleware/logging.js';
import { getDb } from './sqlite.js';
import { withDbLock } from './mutex.js';
import { getGameRoot } from '../utils/path.js';

export { withDbLock };
export { closeDbForTests } from './sqlite.js';

const defaultSettings: Settings = {
  maxVersions: 10,
  steamGridApiKey: '',
  ollamaEndpoint: 'http://ollama:11434',
  ollamaModel: 'phi4-mini:latest',
  apiKeys: [],
  localSources: [],
  remoteServers: []
};

function readSettingsRow(): Settings {
  const row = getDb().prepare('SELECT value FROM kv WHERE key = ?').get('settings') as
    | { value: string }
    | undefined;
  if (!row) return { ...defaultSettings };
  try {
    return { ...defaultSettings, ...(JSON.parse(row.value) as Partial<Settings>) };
  } catch {
    return { ...defaultSettings };
  }
}

function readGamesRows(ownerId?: string): Game[] {
  const db = getDb();
  // rowid order = insertion order, matching the old JSON array semantics.
  const rows = (ownerId
    ? db.prepare('SELECT * FROM games WHERE ownerId = ? ORDER BY rowid').all(ownerId)
    : db.prepare('SELECT * FROM games ORDER BY rowid').all()) as Array<{
    id: number;
    name: string;
    status: string;
    lastSync: string;
    thumbnail: string;
    analysis: string | null;
    ownerId: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status as Game['status'],
    lastSync: r.lastSync,
    thumbnail: r.thumbnail,
    ...(r.analysis ? { analysis: JSON.parse(r.analysis) } : {}),
    ...(r.ownerId ? { ownerId: r.ownerId } : {}),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

function getSettings(): Settings {
  return readSettingsRow();
}

function saveSettings(settings: Settings): void {
  getDb()
    .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('settings', JSON.stringify(settings));
}

/** All games (admin/system view). Pass `ownerId` to scope to one user. */
function getGames(ownerId?: string): Game[] {
  return readGamesRows(ownerId);
}

/** Scope a listing to what `user` may see: admins see everything. */
function getGamesForUser(user: User): Game[] {
  return user.role === 'admin' ? readGamesRows() : readGamesRows(user.id);
}

function getGameById(id: number, ownerId?: string): Game | undefined {
  return getGames(ownerId).find((g) => g.id === id);
}

export function writeDB(data: { games: Game[]; settings: Settings }): void {
  const database = getDb();
  const insertGame = database.prepare(
    'INSERT INTO games (id, name, status, lastSync, thumbnail, analysis, ownerId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare('DELETE FROM games').run();
    for (const g of data.games) {
      insertGame.run(
        g.id, g.name, g.status, g.lastSync, g.thumbnail || '',
        g.analysis ? JSON.stringify(g.analysis) : null,
        g.ownerId ?? null,
        g.createdAt, g.updatedAt,
      );
    }
    saveSettings(data.settings);
    database.exec('COMMIT');
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
}

function getGameByName(name: string, ownerId?: string): Game | undefined {
  const rows = ownerId ? getGames(ownerId) : getGames();
  return rows.find((g) => g.name === name);
}

function upsertGame(
  game: Omit<Game, 'createdAt' | 'thumbnail' | 'id' | 'updatedAt'> &
    Partial<Pick<Game, 'id' | 'thumbnail' | 'createdAt' | 'updatedAt'>>,
): Game {
  const now = new Date().toISOString();
  const ownerId = game.ownerId ?? null;
  const existing = getDb()
    .prepare('SELECT id, createdAt, thumbnail, analysis FROM games WHERE name = ? AND ownerId IS ?')
    .get(game.name, ownerId) as
    | { id: number; createdAt: string; thumbnail: string; analysis: string | null }
    | undefined;

  if (existing) {
    // Preserve stored fields the caller didn't supply: a bare status update
    // (e.g. local sync) must not silently wipe AI analysis or cover art.
    const thumbnail = game.thumbnail !== undefined ? game.thumbnail : existing.thumbnail;
    const analysis = game.analysis !== undefined ? JSON.stringify(game.analysis) : existing.analysis;
    getDb()
      .prepare(
        'UPDATE games SET status = ?, lastSync = ?, thumbnail = ?, analysis = ?, updatedAt = ? WHERE name = ? AND ownerId IS ?',
      )
      .run(game.status, game.lastSync, thumbnail, analysis, now, game.name, ownerId);
    return { ...game, thumbnail, ownerId: ownerId ?? undefined, id: existing.id, createdAt: existing.createdAt, updatedAt: now };
  }

  const created: Game = {
    ...game,
    thumbnail: game.thumbnail ?? '',
    ownerId: ownerId ?? undefined,
    id: nextId(),
    createdAt: now,
    updatedAt: now,
  };
  getDb()
    .prepare(
      'INSERT INTO games (id, name, status, lastSync, thumbnail, analysis, ownerId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      created.id, created.name, created.status, created.lastSync, created.thumbnail,
      created.analysis ? JSON.stringify(created.analysis) : null,
      ownerId,
      created.createdAt, created.updatedAt,
    );
  return created;
}

/** Delete a game. Pass `ownerId` to restrict deletion to that user's rows. */
function deleteGame(id: number, ownerId?: string): boolean {
  const res = ownerId
    ? getDb().prepare('DELETE FROM games WHERE id = ? AND ownerId = ?').run(id, ownerId)
    : getDb().prepare('DELETE FROM games WHERE id = ?').run(id);
  return (res.changes as number) > 0;
}

/**
 * Whether `user` may read/write a game's files. Admins may touch anything;
 * members only their own games. Unknown games are admin-only (a member should
 * not reach files for a game that isn't in their library yet).
 */
function canAccessGame(user: User, gameName: string): boolean {
  if (user.role === 'admin') return true;
  return getGames(user.id).some((g) => g.name === gameName);
}

/** Insert a minimal game row owned by `ownerId` (no-op if the name exists). */
function createOwnedGame(name: string, ownerId: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      'INSERT OR IGNORE INTO games (id, name, status, lastSync, thumbnail, analysis, ownerId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(nextId(), name, 'Pending Upload', 'Never', '', null, ownerId, now, now);
}

/**
 * Non-mutating check: may `user` write files for `gameName`? An unknown name
 * is writable — the uploader claims it on success via `claimGame`. Admins may
 * write anything; members only their own games.
 */
function canWriteGame(user: User, gameName: string): boolean {
  if (user.role === 'admin') return true;
  const existing = getGameByName(gameName);
  return !existing || !existing.ownerId || existing.ownerId === user.id;
}

/**
 * Claim a brand-new or unowned game for `ownerId`. Called after a successful
 * upload so a failed transfer doesn't leave a phantom game row. No-op when
 * another user already owns the name.
 */
function claimGame(gameName: string, ownerId: string): void {
  const existing = getGameByName(gameName);
  if (!existing) {
    createOwnedGame(gameName, ownerId);
  } else if (!existing.ownerId) {
    getDb().prepare('UPDATE games SET ownerId = ?, updatedAt = ? WHERE name = ?')
      .run(ownerId, new Date().toISOString(), gameName);
  }
}

// ── Users & API keys ─────────────────────────────────────────────────────────

interface UserRow {
  id: string;
  name: string;
  role: string;
  createdAt: string;
  updatedAt: string;
}

function rowToUser(r: UserRow): User {
  return { id: r.id, name: r.name, role: r.role as UserRole, createdAt: r.createdAt, updatedAt: r.updatedAt };
}

function listUsers(): User[] {
  const rows = getDb().prepare('SELECT * FROM users ORDER BY rowid').all() as unknown as UserRow[];
  return rows.map(rowToUser);
}

function getUserById(id: string): User | undefined {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow | undefined;
  return row ? rowToUser(row) : undefined;
}

function getUserByName(name: string): User | undefined {
  const row = getDb().prepare('SELECT * FROM users WHERE name = ?').get(name) as unknown as UserRow | undefined;
  return row ? rowToUser(row) : undefined;
}

function createUser(name: string, role: UserRole): User {
  const now = new Date().toISOString();
  const user: User = {
    id: 'usr_' + randomBytes(9).toString('hex'),
    name,
    role,
    createdAt: now,
    updatedAt: now,
  };
  getDb()
    .prepare('INSERT INTO users (id, name, role, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)')
    .run(user.id, user.name, user.role, user.createdAt, user.updatedAt);
  return user;
}

function setUserRole(id: string, role: UserRole): boolean {
  const res = getDb()
    .prepare('UPDATE users SET role = ?, updatedAt = ? WHERE id = ?')
    .run(role, new Date().toISOString(), id);
  return (res.changes as number) > 0;
}

/** Remove a user, their keys, and their games in one transaction. */
function deleteUser(id: string): boolean {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const res = db.prepare('DELETE FROM users WHERE id = ?').run(id);
    db.prepare('DELETE FROM user_keys WHERE userId = ?').run(id);
    db.prepare('DELETE FROM games WHERE ownerId = ?').run(id);
    db.exec('COMMIT');
    return (res.changes as number) > 0;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function countAdmins(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number };
  return Number(row.n);
}

function countUserKeys(userId: string): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM user_keys WHERE userId = ?').get(userId) as { n: number };
  return Number(row.n);
}

/** High-entropy key; shown to the operator exactly once. */
function generateApiKey(): string {
  return 'dune_' + randomBytes(24).toString('hex');
}

function insertKeyHash(hash: string, userId: string, description: string): void {
  getDb()
    .prepare('INSERT OR IGNORE INTO user_keys (hash, userId, description, createdAt) VALUES (?, ?, ?, ?)')
    .run(hash, userId, description, new Date().toISOString());
}

function addUserKey(userId: string, rawKey: string, description = ''): void {
  insertKeyHash(hashApiKey(rawKey), userId, description);
}

/** Create a fresh key for a user; returns the plaintext key (shown once). */
function issueUserKey(userId: string, description = ''): string {
  const raw = generateApiKey();
  addUserKey(userId, raw, description);
  return raw;
}

function listUserKeys(userId: string): ApiKeyRecord[] {
  return getDb()
    .prepare('SELECT hash, userId, description, createdAt FROM user_keys WHERE userId = ? ORDER BY rowid')
    .all(userId) as unknown as ApiKeyRecord[];
}

function listKeyHashes(): string[] {
  return (getDb().prepare('SELECT hash FROM user_keys').all() as unknown as Array<{ hash: string }>).map((r) => r.hash);
}

function removeUserKeyByHash(hash: string): boolean {
  const res = getDb().prepare('DELETE FROM user_keys WHERE hash = ?').run(hash);
  return (res.changes as number) > 0;
}

/** Resolve a presented key to its user, or null. Comparison is constant-time. */
function resolveUserByKey(rawKey: string | null | undefined): User | null {
  if (!rawKey) return null;
  const rows = getDb().prepare('SELECT hash, userId FROM user_keys').all() as Array<{
    hash: string;
    userId: string;
  }>;
  const matched = matchStoredHash(rawKey, rows.map((r) => r.hash));
  if (!matched) return null;
  const row = rows.find((r) => r.hash === matched);
  return row ? getUserById(row.userId) ?? null : null;
}

/** Constant-time check of a raw candidate against every stored key hash. */
function isValidApiKey(candidate: string | undefined | null): boolean {
  return matchStoredHash(candidate, listKeyHashes()) !== null;
}

/** Every stored key hash (all users). */
function getApiKeys(): string[] {
  return listKeyHashes();
}

/** Issue an additional key for the first admin (bootstrapping/tests). */
function addApiKey(key: string, description = ''): boolean {
  const owner = listUsers().find((u) => u.role === 'admin') ?? listUsers()[0];
  if (!owner) return false;
  addUserKey(owner.id, key, description);
  return true;
}

/** Revoke a key across all users, by its plaintext value. */
function removeApiKey(key: string): boolean {
  return removeUserKeyByHash(hashApiKey(key));
}

function getLocalSources(): LocalSource[] {
  return readSettingsRow().localSources || [];
}

function addLocalSource(sourcePath: string): LocalSource {
  const settings = readSettingsRow();
  if (!settings.localSources) settings.localSources = [];
  // nextId (not Date.now()) so two adds in the same millisecond don't share an
  // id, which would make removeLocalSource(id) delete both rows.
  const source = { id: nextId(), path: sourcePath };
  settings.localSources.push(source);
  saveSettings(settings);
  return source;
}

function removeLocalSource(id: number): boolean {
  const settings = readSettingsRow();
  const initialLength = settings.localSources?.length || 0;
  settings.localSources = (settings.localSources || []).filter(s => s.id !== id);
  if (settings.localSources.length !== initialLength) {
    saveSettings(settings);
    return true;
  }
  return false;
}

function getRemoteServers(): RemoteServer[] {
  return readSettingsRow().remoteServers || [];
}

function addRemoteServer(url: string): RemoteServer {
  const settings = readSettingsRow();
  if (!settings.remoteServers) settings.remoteServers = [];
  // See addLocalSource: nextId avoids same-millisecond id collisions.
  const server = { id: nextId(), url };
  settings.remoteServers.push(server);
  saveSettings(settings);
  return server;
}

function removeRemoteServer(id: number): boolean {
  const settings = readSettingsRow();
  const initialLength = settings.remoteServers?.length || 0;
  settings.remoteServers = (settings.remoteServers || []).filter(s => s.id !== id);
  if (settings.remoteServers.length !== initialLength) {
    saveSettings(settings);
    return true;
  }
  return false;
}

// ── Boot migrations ──────────────────────────────────────────────────────────

/**
 * One-way migration: hash any plaintext keys left from pre-hardening installs.
 * Idempotent — already-hashed entries are untouched.
 */
function migrateApiKeys(): boolean {
  const settings = readSettingsRow();
  const keys = settings.apiKeys || [];
  let changed = false;
  const migrated = keys.map(k => {
    if (looksHashed(k)) return k;
    changed = true;
    return hashApiKey(k);
  });
  // Deduplicate in case two plaintext keys hashed identically
  const deduped = [...new Set(migrated)];
  if (changed || deduped.length !== keys.length) {
    settings.apiKeys = deduped;
    saveSettings(settings);
    return true;
  }
  return false;
}

/**
 * Ensure at least one admin exists and no game is ownerless. Moves legacy
 * `settings.apiKeys` hashes onto the first admin, then clears them so keys are
 * managed per-user from here on. Idempotent.
 */
function migrateSavesLayout(): void {
  for (const game of getGames()) {
    if (!game.ownerId) continue;
    const legacy = getGameRoot(game.name);
    const target = getGameRoot(game.name, game.ownerId);
    if (legacy === target) continue;
    if (!fs.existsSync(legacy)) continue;
    if (fs.existsSync(target)) continue;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(legacy, target);
      logger.info({ game: game.name, owner: game.ownerId }, 'Migrated saves into per-owner layout');
    } catch (err) {
      logger.warn({ err, game: game.name }, 'Failed to migrate saves layout');
    }
  }
}

function ensureMultiUser(): void {
  let admins = listUsers().filter((u) => u.role === 'admin');
  if (listUsers().length === 0) {
    const admin = createUser('admin', 'admin');
    admins = [admin];
    const settings = readSettingsRow();
    const legacy = settings.apiKeys || [];
    for (const hash of legacy) insertKeyHash(hash, admin.id, 'Migrated key');
    if (legacy.length) {
      settings.apiKeys = [];
      saveSettings(settings);
    }
    logger.info({ user: admin.name }, 'Created default admin user');
  }

  const owner = admins[0] ?? listUsers()[0];
  if (owner) {
    const res = getDb().prepare('UPDATE games SET ownerId = ? WHERE ownerId IS NULL').run(owner.id);
    if ((res.changes as number) > 0) {
      logger.info({ count: res.changes, owner: owner.name }, 'Assigned ownerless games to admin');
    }
  }
}

/**
 * Boot migrations, run once on import. Exposed so tests can re-run them after
 * swapping the database file (production opens the real DB exactly once).
 */
export function runBootMigrations(): void {
  if (migrateApiKeys()) {
    logger.info('Migrated plaintext API keys to hashes');
  }

  ensureMultiUser();

  migrateSavesLayout();

  if (listKeyHashes().length === 0) {
    const admin = listUsers()[0];
    const defaultKey = 'dune-dev-key-' + Date.now();
    addUserKey(admin.id, defaultKey, 'Default development key');
    logger.warn('Generated default API key — replace it via users.addKey and delete this one');
    // Full key shown once on purpose: a fresh install has no other way to
    // obtain a key (adding one requires auth). Rotate it immediately.
    logger.info({ apiKey: defaultKey }, 'Default API key (shown once)');
  }
}

runBootMigrations();

export const database = {
  getSettings,
  saveSettings,
  getGames,
  getGamesForUser,
  getGameById,
  getGameByName,
  canAccessGame,
  canWriteGame,
  claimGame,
  upsertGame,
  deleteGame,
  getLocalSources,
  addLocalSource,
  removeLocalSource,
  getRemoteServers,
  addRemoteServer,
  removeRemoteServer,
  listUsers,
  getUserById,
  getUserByName,
  createUser,
  setUserRole,
  deleteUser,
  countAdmins,
  countUserKeys,
  generateApiKey,
  issueUserKey,
  addUserKey,
  listUserKeys,
  listKeyHashes,
  removeUserKeyByHash,
  resolveUserByKey,
  isValidApiKey,
  getApiKeys,
  addApiKey,
  removeApiKey
} as const;
