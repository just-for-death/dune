import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { nextId } from '@dune/shared';
import { dataDir, savesDir, ownerSavesRoot, assertStrictlyInside } from '../utils/path.js';
import type {
  Game,
  GameStoreIds,
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

export { withDbLock };
export { closeDbForTests } from './sqlite.js';

/** DUN-057: the pre-fix implicit default, written into stored settings by every save. */
const LEGACY_OLLAMA_DEFAULT = 'http://ollama:11434';

const defaultSettings: Settings = {
  maxVersions: 10,
  // DUN-057: Ollama is off until an admin sets an endpoint.
  ollamaEndpoint: '',
  ollamaModel: 'phi4-mini:latest',
  apiKeys: [],
  localSources: [],
  remoteServers: [],
  // Outbound providers are opt-in (no request leaves the server until enabled).
  hltbEnabled: false,
  artworkEnabled: false,
  manifestEnabled: false,
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

function readGamesRows(ownerId?: string, id?: number): Game[] {
  const db = getDb();
  // rowid order = insertion order, matching the old JSON array semantics.
  // Explicit columns: no launch/exec fields exist or are ever returned (DUN-061).
  const cols = 'id, name, status, lastSync, thumbnail, analysis, ownerId, steamAppId, gogId, createdAt, updatedAt';
  const rows = (id !== undefined
    ? db.prepare(`SELECT ${cols} FROM games WHERE id = ?`).all(id)
    : ownerId
      ? db.prepare(`SELECT ${cols} FROM games WHERE ownerId = ? ORDER BY rowid`).all(ownerId)
      : db.prepare(`SELECT ${cols} FROM games ORDER BY rowid`).all()) as Array<{
    id: number;
    name: string;
    status: string;
    lastSync: string;
    thumbnail: string;
    analysis: string | null;
    ownerId: string | null;
    steamAppId: string | null;
    gogId: string | null;
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
    ownerId: r.ownerId ?? '',
    steamAppId: r.steamAppId ?? null,
    gogId: r.gogId ?? null,
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

// ── Games: owner-scoped (DUN-087/088) ───────────────────────────────────────
// Every game belongs to exactly one owner and is identified by
// (ownerId, name) with SQLite NOCASE matching (ASCII case-insensitive; see
// idx_games_owner_name_nocase). Saves live at saves/<ownerId>/<gameId>, so a
// rename never moves files.

/** The caller's game with this title (case-insensitive), if any. */
function findGame(ownerId: string, name: string): Game | undefined {
  const row = getDb()
    .prepare('SELECT id FROM games WHERE ownerId = ? AND name = ? COLLATE NOCASE ORDER BY rowid LIMIT 1')
    .get(ownerId, name) as { id: number } | undefined;
  return row ? getGameById(row.id) : undefined;
}

/** Owner-scoped lookup by title. `ownerId` is required (DUN-088). */
function getGameByName(name: string, ownerId: string): Game | undefined {
  return findGame(ownerId, name);
}

/** Any owner's game by id. Only for admin-by-id paths and internal joins. */
function getGameById(id: number): Game | undefined {
  return readGamesRows(undefined, id)[0];
}

/** The game with this id only if `ownerId` owns it. */
function getOwnedGame(id: number, ownerId: string): Game | undefined {
  const g = getGameById(id);
  return g && g.ownerId === ownerId ? g : undefined;
}

/**
 * Find-or-create the caller's game row for `name` (an already validated
 * title). Upload creates the row first, then the id-named folder.
 * FEAT-server-storeIds: `ids` (already validated) are stored on the new row,
 * or overwrite the existing row's values key by key; an absent key keeps the
 * stored value. Only the caller's own row is ever touched.
 */
function ensureGame(ownerId: string, name: string, ids: GameStoreIds = {}): Game {
  const existing = findGame(ownerId, name);
  if (existing) {
    const steamAppId = ids.steamAppId ?? existing.steamAppId ?? null;
    const gogId = ids.gogId ?? existing.gogId ?? null;
    if (steamAppId === (existing.steamAppId ?? null) && gogId === (existing.gogId ?? null)) return existing;
    getDb()
      .prepare('UPDATE games SET steamAppId = ?, gogId = ?, updatedAt = ? WHERE id = ? AND ownerId = ?')
      .run(steamAppId, gogId, new Date().toISOString(), existing.id, ownerId);
    return getGameById(existing.id) as Game;
  }
  const now = new Date().toISOString();
  const id = nextId();
  getDb()
    .prepare(
      'INSERT INTO games (id, name, status, lastSync, thumbnail, analysis, ownerId, steamAppId, gogId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, name, 'Pending Upload', 'Never', '', null, ownerId, ids.steamAppId ?? null, ids.gogId ?? null, now, now);
  return getGameById(id) as Game;
}

/**
 * DUN-085: mark ONE game as freshly synced after a successful upload, by id.
 * Never deletes: child tables cascade on game delete.
 */
function markGameSynced(gameId: number, timestamp: string = new Date().toISOString()): boolean {
  const res = getDb()
    .prepare("UPDATE games SET status = 'In Sync', lastSync = ?, updatedAt = ? WHERE id = ?")
    .run(timestamp, timestamp, gameId);
  return (res.changes as number) > 0;
}

/** Rename the caller's game. Files stay put (the folder is the id). */
function renameGame(id: number, ownerId: string, newName: string): 'ok' | 'not_found' | 'conflict' {
  const game = getOwnedGame(id, ownerId);
  if (!game) return 'not_found';
  const clash = findGame(ownerId, newName);
  if (clash && clash.id !== id) return 'conflict';
  getDb().prepare('UPDATE games SET name = ?, updatedAt = ? WHERE id = ?').run(newName, new Date().toISOString(), id);
  return 'ok';
}

function upsertGame(
  game: Omit<Game, 'createdAt' | 'thumbnail' | 'id' | 'updatedAt' | 'ownerId'> &
    Partial<Pick<Game, 'id' | 'thumbnail' | 'createdAt' | 'updatedAt'>> & { ownerId: string },
): Game {
  const now = new Date().toISOString();
  const ownerId = game.ownerId;
  const existing = getDb()
    .prepare('SELECT id, createdAt, thumbnail, analysis FROM games WHERE ownerId = ? AND name = ? COLLATE NOCASE LIMIT 1')
    .get(ownerId, game.name) as
    | { id: number; createdAt: string; thumbnail: string; analysis: string | null }
    | undefined;

  if (existing) {
    // Preserve stored fields the caller didn't supply: a bare status update
    // (e.g. local sync) must not silently wipe AI analysis or cover art.
    const thumbnail = game.thumbnail !== undefined ? game.thumbnail : existing.thumbnail;
    const analysis = game.analysis !== undefined ? JSON.stringify(game.analysis) : existing.analysis;
    getDb()
      .prepare(
        'UPDATE games SET status = ?, lastSync = ?, thumbnail = ?, analysis = ?, updatedAt = ? WHERE id = ?',
      )
      .run(game.status, game.lastSync, thumbnail, analysis, now, existing.id);
    return getGameById(existing.id) as Game;
  }

  // Explicit fields only: nothing else the caller passed is stored or echoed.
  const created: Game = {
    name: game.name,
    status: game.status,
    lastSync: game.lastSync,
    thumbnail: game.thumbnail ?? '',
    ...(game.analysis ? { analysis: game.analysis } : {}),
    ownerId,
    steamAppId: game.steamAppId ?? null,
    gogId: game.gogId ?? null,
    id: nextId(),
    createdAt: now,
    updatedAt: now,
  };
  getDb()
    .prepare(
      'INSERT INTO games (id, name, status, lastSync, thumbnail, analysis, ownerId, steamAppId, gogId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      created.id, created.name, created.status, created.lastSync, created.thumbnail,
      created.analysis ? JSON.stringify(created.analysis) : null,
      ownerId,
      created.steamAppId ?? null, created.gogId ?? null,
      created.createdAt, created.updatedAt,
    );
  return created;
}

/**
 * FEAT-server-gamePatch: set/clear the store ids of the owner's game. A key
 * that is undefined keeps its value; null clears it. Returns the updated row,
 * or undefined when the game is missing or belongs to another owner.
 */
function setGameStoreIds(
  id: number,
  ownerId: string,
  patch: { steamAppId?: string | null; gogId?: string | null },
): Game | undefined {
  const game = getOwnedGame(id, ownerId);
  if (!game) return undefined;
  const steamAppId = patch.steamAppId !== undefined ? patch.steamAppId : game.steamAppId ?? null;
  const gogId = patch.gogId !== undefined ? patch.gogId : game.gogId ?? null;
  getDb()
    .prepare('UPDATE games SET steamAppId = ?, gogId = ?, updatedAt = ? WHERE id = ? AND ownerId = ?')
    .run(steamAppId, gogId, new Date().toISOString(), id, ownerId);
  return getGameById(id);
}

/** Delete the owner's game (DUN-087). Child rows cascade; files are the caller's job. */
function deleteGame(id: number, ownerId: string): boolean {
  const res = getDb().prepare('DELETE FROM games WHERE id = ? AND ownerId = ?').run(id, ownerId);
  return (res.changes as number) > 0;
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
    // Children first (DUN-085): games.ownerId is ON DELETE SET NULL, so
    // deleting the user row first nulled ownerId and this per-owner game
    // delete matched nothing, leaving orphaned games + versions behind.
    // Deleting the user's games here cascades to only *their* child rows.
    db.prepare('DELETE FROM games WHERE ownerId = ?').run(id);
    db.prepare('DELETE FROM user_keys WHERE userId = ?').run(id);
    const res = db.prepare('DELETE FROM users WHERE id = ?').run(id);
    db.exec('COMMIT');
    
    // Remove the user's save files from disk after DB commit
    try {
      // saves/<id> via the validated owner root, strictly inside saves/.
      const userSaveDir = ownerSavesRoot(id);
      assertStrictlyInside(userSaveDir, savesDir(), 'User save folder');
      if (fs.lstatSync(userSaveDir, { throwIfNoEntry: false })?.isDirectory()) {
        fs.rmSync(userSaveDir, { recursive: true, force: true });
        logger.info({ userId: id }, 'Removed user save directory');
      }
    } catch (err) {
      logger.warn({ err, userId: id }, 'Failed to remove user save directory');
    }
    
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

function insertKeyHash(hash: string, userId: string, description: string): boolean {
  const result = getDb()
    .prepare('INSERT OR IGNORE INTO user_keys (hash, userId, description, createdAt) VALUES (?, ?, ?, ?)')
    .run(hash, userId, description, new Date().toISOString());
  return (result.changes as number) > 0;
}

function addUserKey(userId: string, rawKey: string, description = ''): boolean {
  return insertKeyHash(hashApiKey(rawKey), userId, description);
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

// ── Local sync game identity (DUN-100) ──────────────────────────────────────
// A local-sync folder is bound to one game by its full normalized path (per
// owner), never by its basename, so two different `.../Saves` folders stay
// two games.

/** The game bound to this source folder for this owner, if any. */
function getLocalSyncGame(ownerId: string, sourcePath: string): Game | undefined {
  const row = getDb()
    .prepare('SELECT gameId FROM local_sync_games WHERE ownerId = ? AND sourcePath = ?')
    .get(ownerId, sourcePath) as { gameId: number } | undefined;
  return row ? getGameById(row.gameId) : undefined;
}

/** True when some other folder of this owner is already bound to `gameId`. */
function isGameBoundToOtherFolder(ownerId: string, gameId: number, sourcePath: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS x FROM local_sync_games WHERE ownerId = ? AND gameId = ? AND sourcePath <> ? LIMIT 1')
    .get(ownerId, gameId, sourcePath);
  return Boolean(row);
}

function bindLocalSyncGame(ownerId: string, sourcePath: string, gameId: number): void {
  getDb()
    .prepare('INSERT INTO local_sync_games (ownerId, sourcePath, gameId) VALUES (?, ?, ?) ON CONFLICT(ownerId, sourcePath) DO UPDATE SET gameId = excluded.gameId')
    .run(ownerId, sourcePath, gameId);
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
/**
 * DUN-057: settings saved before the fix carry the old implicit
 * 'http://ollama:11434' default (saveSettings stored the merged defaults).
 * Clear exactly that value so Ollama is off until an admin sets an endpoint.
 */
function migrateOllamaDefault(): boolean {
  const row = getDb().prepare('SELECT value FROM kv WHERE key = ?').get('settings') as { value: string } | undefined;
  if (!row) return false;
  const settings = readSettingsRow();
  if (settings.ollamaEndpoint !== LEGACY_OLLAMA_DEFAULT) return false;
  saveSettings({ ...settings, ollamaEndpoint: '' });
  return true;
}

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
function ensureMultiUser(): void {
  // Create an admin if none exists (covers fresh DBs and DBs that lost
  // their admin rows).
  let admins = listUsers().filter((u) => u.role === 'admin');
  if (admins.length === 0) {
    const admin = createUser('admin', 'admin');
    admins = [admin];
    logger.info({ user: admin.name }, 'Created default admin user');
  }

  // Idempotent legacy-key adoption: run whenever there are unadopted hashed
  // keys in settings.apiKeys, regardless of whether users pre-existed.
  const settings = readSettingsRow();
  const legacy = settings.apiKeys || [];
  if (legacy.length > 0 && admins[0]) {
    for (const hash of legacy) insertKeyHash(hash, admins[0].id, 'Migrated key');
    settings.apiKeys = [];
    saveSettings(settings);
    logger.info('Migrated plaintext API keys to hashes');
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

  if (migrateOllamaDefault()) {
    logger.info('Cleared the implicit Ollama endpoint default; Ollama stays off until configured');
  }

  if (listKeyHashes().length === 0) {
    const admin = listUsers()[0];
    const defaultKey = randomBytes(24).toString('hex');
    addUserKey(admin.id, defaultKey, 'Default development key');
    // Write the full key to a one-time file (mode 0600) instead of logging
    // it: logs may persist, the file is read once and then deleted by the
    // operator. The key itself is high-entropy (192 bits).
    if (writeBootstrapKey(defaultKey)) {
      logger.warn('Generated default API key — read it from data/.bootstrap-key, then delete that file and rotate the key');
    }
  }
}

/**
 * DUN-116: the file must always hold the key that is valid NOW. Previously a
 * stale .bootstrap-key (from an earlier DB) blocked the write, so the operator
 * read a dead key and was locked out. Write a private temp file and rename it
 * over whatever is there (atomic; never a half-written or world-readable key).
 * The key itself is never logged.
 */
function writeBootstrapKey(key: string): boolean {
  const keyFile = path.join(dataDir(), '.bootstrap-key');
  const tmp = `${keyFile}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, key, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, keyFile);
    return true;
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    logger.error(
      { err },
      'Generated a default API key but could not write data/.bootstrap-key; fix the data dir permissions and restart, or issue a key with an existing admin key',
    );
    return false;
  }
}

runBootMigrations();

export const database = {
  getSettings,
  saveSettings,
  getGames,
  getGamesForUser,
  getGameByName,
  getGameById,
  getOwnedGame,
  findGame,
  ensureGame,
  upsertGame,
  markGameSynced,
  renameGame,
  setGameStoreIds,
  deleteGame,
  getLocalSyncGame,
  isGameBoundToOtherFolder,
  bindLocalSyncGame,
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
  listUserKeys,
  listKeyHashes,
  removeUserKeyByHash,
  resolveUserByKey,
} as const;
