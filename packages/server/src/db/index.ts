import * as path from 'path';
import * as fs from 'fs';
import type { Game, Settings, LocalSource, RemoteServer } from '../types/index.js';
import { hashApiKey, looksHashed, isValidApiKey as checkKey } from '../utils/crypto.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'dune.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const defaultSettings: Settings = {
  maxVersions: 10,
  steamGridApiKey: '',
  ollamaEndpoint: 'http://ollama:11434',
  ollamaModel: 'phi4-mini:latest',
  apiKeys: [],
  localSources: [],
  remoteServers: []
};

function readDB(): { games: Game[]; settings: Settings } {
  if (!fs.existsSync(DB_PATH)) {
    return { games: [], settings: defaultSettings };
  }
  try {
    const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    return {
      games: data.games || [],
      settings: { ...defaultSettings, ...data.settings }
    };
  } catch {
    return { games: [], settings: defaultSettings };
  }
}

export function writeDB(data: { games: Game[]; settings: Settings }): void {
  const tmpPath = DB_PATH + '.tmp.' + Date.now();
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, DB_PATH);
}

function getSettings(): Settings {
  return readDB().settings;
}

function saveSettings(settings: Settings): void {
  const db = readDB();
  db.settings = settings;
  writeDB(db);
}

function getGames(): Game[] {
  return readDB().games;
}

function upsertGame(game: Omit<Game, 'createdAt'> & { createdAt?: string }): Game {
  const db = readDB();
  const now = new Date().toISOString();
  const existingIdx = db.games.findIndex(g => g.name === game.name);
  
  if (existingIdx >= 0) {
    const existing = db.games[existingIdx];
    const updated = { 
      ...game, 
      id: existing.id, 
      createdAt: existing.createdAt, 
      updatedAt: now 
    };
    db.games[existingIdx] = updated;
    writeDB(db);
    return updated;
  } else {
    const newGame = { 
      ...game, 
      id: Date.now() + Math.random(), 
      createdAt: now, 
      updatedAt: now 
    };
    db.games.push(newGame);
    writeDB(db);
    return newGame;
  }
}

function deleteGame(id: number): boolean {
  const db = readDB();
  const initialLength = db.games.length;
  db.games = db.games.filter(g => g.id !== id);
  if (db.games.length !== initialLength) {
    writeDB(db);
    return true;
  }
  return false;
}

function getLocalSources(): LocalSource[] {
  return readDB().settings.localSources || [];
}

function addLocalSource(sourcePath: string): LocalSource {
  const db = readDB();
  if (!db.settings.localSources) db.settings.localSources = [];
  const source = { id: Date.now(), path: sourcePath };
  db.settings.localSources.push(source);
  writeDB(db);
  return source;
}

function removeLocalSource(id: number): boolean {
  const db = readDB();
  const initialLength = db.settings.localSources?.length || 0;
  db.settings.localSources = (db.settings.localSources || []).filter(s => s.id !== id);
  if (db.settings.localSources.length !== initialLength) {
    writeDB(db);
    return true;
  }
  return false;
}

function getRemoteServers(): RemoteServer[] {
  return readDB().settings.remoteServers || [];
}

function addRemoteServer(url: string): RemoteServer {
  const db = readDB();
  if (!db.settings.remoteServers) db.settings.remoteServers = [];
  const server = { id: Date.now(), url };
  db.settings.remoteServers.push(server);
  writeDB(db);
  return server;
}

function removeRemoteServer(id: number): boolean {
  const db = readDB();
  const initialLength = db.settings.remoteServers?.length || 0;
  db.settings.remoteServers = (db.settings.remoteServers || []).filter(s => s.id !== id);
  if (db.settings.remoteServers.length !== initialLength) {
    writeDB(db);
    return true;
  }
  return false;
}

function getApiKeys(): string[] {
  return readDB().settings.apiKeys || [];
}

/** Store only hashes — never plaintext. */
function addApiKey(key: string, description = ''): void {
  const db = readDB();
  if (!db.settings.apiKeys) db.settings.apiKeys = [];
  const hashed = hashApiKey(key);
  if (!db.settings.apiKeys.includes(hashed)) {
    db.settings.apiKeys.push(hashed);
    writeDB(db);
  }
}

function removeApiKey(key: string): boolean {
  const db = readDB();
  const initialLength = db.settings.apiKeys?.length || 0;
  const hashed = hashApiKey(key);
  db.settings.apiKeys = (db.settings.apiKeys || []).filter(k => k !== hashed);
  if (db.settings.apiKeys.length !== initialLength) {
    writeDB(db);
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
  const db = readDB();
  const keys = db.settings.apiKeys || [];
  let changed = false;
  const migrated = keys.map(k => {
    if (looksHashed(k)) return k;
    changed = true;
    return hashApiKey(k);
  });
  // Deduplicate in case two plaintext keys hashed identically
  const deduped = [...new Set(migrated)];
  if (changed || deduped.length !== keys.length) {
    db.settings.apiKeys = deduped;
    writeDB(db);
    return true;
  }
  return false;
}

if (migrateApiKeys()) {
  console.log('[DB] Migrated plaintext API keys to hashes.');
}

if (getApiKeys().length === 0) {
  const defaultKey = 'dune-dev-key-' + Date.now();
  addApiKey(defaultKey, 'Default development key');
  console.log(`[DB] Generated default API key: ${defaultKey}`);
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
