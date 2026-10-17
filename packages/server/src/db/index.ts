import type { Game, Settings, LocalSource, RemoteServer } from '../types/index.js';
import { hashApiKey, looksHashed, isValidApiKey as checkKey } from '../utils/crypto.js';
import { logger } from '../middleware/logging.js';
import { getDb } from './sqlite.js';
import { withDbLock } from './mutex.js';

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

function readGamesRows(): Game[] {
  // rowid order = insertion order, matching the old JSON array semantics.
  const rows = getDb().prepare('SELECT * FROM games ORDER BY rowid').all() as Array<{
    id: number;
    name: string;
    status: string;
    lastSync: string;
    thumbnail: string;
    analysis: string | null;
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

function getGames(): Game[] {
  return readGamesRows();
}

export function writeDB(data: { games: Game[]; settings: Settings }): void {
  const database = getDb();
  const insertGame = database.prepare(
    'INSERT INTO games (id, name, status, lastSync, thumbnail, analysis, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare('DELETE FROM games').run();
    for (const g of data.games) {
      insertGame.run(
        g.id, g.name, g.status, g.lastSync, g.thumbnail || '',
        g.analysis ? JSON.stringify(g.analysis) : null,
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

function upsertGame(
  game: Omit<Game, 'createdAt' | 'thumbnail' | 'id' | 'updatedAt'> &
    Partial<Pick<Game, 'id' | 'thumbnail' | 'createdAt' | 'updatedAt'>>,
): Game {
  const now = new Date().toISOString();
  const existing = getDb()
    .prepare('SELECT id, createdAt, thumbnail, analysis FROM games WHERE name = ?')
    .get(game.name) as
    | { id: number; createdAt: string; thumbnail: string; analysis: string | null }
    | undefined;

  if (existing) {
    // Preserve stored fields the caller didn't supply: a bare status update
    // (e.g. local sync) must not silently wipe AI analysis or cover art.
    const thumbnail = game.thumbnail !== undefined ? game.thumbnail : existing.thumbnail;
    const analysis = game.analysis !== undefined ? JSON.stringify(game.analysis) : existing.analysis;
    getDb()
      .prepare(
        'UPDATE games SET status = ?, lastSync = ?, thumbnail = ?, analysis = ?, updatedAt = ? WHERE name = ?',
      )
      .run(game.status, game.lastSync, thumbnail, analysis, now, game.name);
    return { ...game, thumbnail, id: existing.id, createdAt: existing.createdAt, updatedAt: now };
  }

  const created: Game = {
    ...game,
    thumbnail: game.thumbnail ?? '',
    id: Date.now() + Math.random(),
    createdAt: now,
    updatedAt: now,
  };
  getDb()
    .prepare(
      'INSERT INTO games (id, name, status, lastSync, thumbnail, analysis, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      created.id, created.name, created.status, created.lastSync, created.thumbnail,
      created.analysis ? JSON.stringify(created.analysis) : null,
      created.createdAt, created.updatedAt,
    );
  return created;
}

function deleteGame(id: number): boolean {
  const res = getDb().prepare('DELETE FROM games WHERE id = ?').run(id);
  return (res.changes as number) > 0;
}

function getLocalSources(): LocalSource[] {
  return readSettingsRow().localSources || [];
}

function addLocalSource(sourcePath: string): LocalSource {
  const settings = readSettingsRow();
  if (!settings.localSources) settings.localSources = [];
  // Date.now() alone collides for two adds in the same millisecond, which
  // would make removeLocalSource(id) delete both rows.
  const source = { id: Date.now() + Math.random(), path: sourcePath };
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
  // See addLocalSource: avoid same-millisecond id collisions.
  const server = { id: Date.now() + Math.random(), url };
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

function getApiKeys(): string[] {
  return readSettingsRow().apiKeys || [];
}

/** Store only hashes — never plaintext. */
function addApiKey(key: string, _description = ''): void {
  const settings = readSettingsRow();
  if (!settings.apiKeys) settings.apiKeys = [];
  const hashed = hashApiKey(key);
  if (!settings.apiKeys.includes(hashed)) {
    settings.apiKeys.push(hashed);
    saveSettings(settings);
  }
}

function removeApiKey(key: string): boolean {
  const settings = readSettingsRow();
  const initialLength = settings.apiKeys?.length || 0;
  const hashed = hashApiKey(key);
  settings.apiKeys = (settings.apiKeys || []).filter(k => k !== hashed);
  if (settings.apiKeys.length !== initialLength) {
    saveSettings(settings);
    return true;
  }
  return false;
}

/** Constant-time check of a raw candidate against stored hashes. */
function isValidApiKey(candidate: string | undefined | null): boolean {
  return checkKey(candidate, getApiKeys());
}

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

if (migrateApiKeys()) {
  logger.info('Migrated plaintext API keys to hashes');
}

if (getApiKeys().length === 0) {
  const defaultKey = 'dune-dev-key-' + Date.now();
  addApiKey(defaultKey, 'Default development key');
  logger.warn('Generated default API key — replace it via apiKeys.add and delete this one');
  // Full key shown once on purpose: a fresh install has no other way to
  // obtain a key (adding one requires auth). Rotate it immediately.
  logger.info({ apiKey: defaultKey }, 'Default API key (shown once)');
}

export const database = {
  getSettings,
  saveSettings,
  getGames,
  upsertGame,
  deleteGame,
  getLocalSources,
  addLocalSource,
  removeLocalSource,
  getRemoteServers,
  addRemoteServer,
  removeRemoteServer,
  getApiKeys,
  addApiKey,
  removeApiKey,
  isValidApiKey
} as const;
