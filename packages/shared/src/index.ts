// Shared types for Dune Client ↔ Server communication

export * from './delta.js';
export * from './id.js';

// Game entity
export interface Game {
  id: number;
  name: string;
  winPath: string;
  linPath: string;
  lastSync: string; // ISO 8601
  status: 'In Sync' | 'Pending Upload' | 'Error';
  thumbnail: string;
  analysis?: Record<string, FileAnalysis>;
  createdAt: string;
  updatedAt: string;
  sourceId?: string; // 'steam' | 'heroic' | 'lutris' | 'manual' | 'epic' | 'gog' | 'ubisoft' | 'ea' | 'battlenet' | 'xbox' | 'minecraft'
  source?: 'steam' | 'heroic' | 'lutris' | 'manual' | 'epic' | 'gog' | 'ubisoft' | 'ea' | 'battlenet' | 'xbox' | 'minecraft' | 'emulator';
  tags?: string[];
  // Optional launcher metadata supplied by source scanners.
  steamAppId?: string;
  heroicId?: string;
  lutrisSlug?: string;
  winePrefix?: string;
  protonPath?: string;
  executable?: string;
  /** Emulator command used for ROM entries (for example `retroarch`). */
  emulator?: string;
  /** Absolute ROM path for emulator entries; may differ from linPath. */
  romPath?: string;
}

// Collection / smart view
export interface CollectionRule {
  field: 'source' | 'status' | 'tag' | 'name' | 'playtime';
  op: 'equals' | 'contains' | 'startsWith' | 'gt' | 'lt';
  value: string | number;
}

export interface Collection {
  id: number;
  name: string;
  logic: 'all' | 'any';
  rules: CollectionRule[];
  createdAt: string;
  updatedAt: string;
}

// File analysis from AI
export interface FileAnalysis {
  category: 'Save' | 'Config' | 'Cache' | 'Other';
  description: string;
}

// Game file metadata
export interface GameFile {
  path: string;
  name: string;
  size: number;
  modified: string; // ISO 8601
  category: 'Save' | 'Config' | 'Cache' | 'Other';
}

// Version snapshot
export interface Version {
  id: string; // timestamp
  timestamp: string; // ISO 8601
}

// Server settings
export interface Settings {
  maxVersions: number;
  steamGridApiKey: string;
  ollamaEndpoint: string;
  ollamaModel: string;
  apiKeys: string[];
  localSources: LocalSource[];
  remoteServers: RemoteServer[];
  // Client-only settings
  runInBackground?: boolean;
  autoSyncEnabled?: boolean;
  autoSyncFreq?: string;
  scanRoots?: string[];
  /** Client-only: SteamGridDB key stored locally (server key is separate). */
  steamGridDbKey?: string;
}

// Local source for dual-boot sync
export interface LocalSource {
  id: number;
  path: string;
}

// Remote server for replication
export interface RemoteServer {
  id: number;
  url: string;
}

// A masked API key belonging to the authenticated user. The plaintext key is
// only ever returned once, at creation time.
export interface ApiKeyInfo {
  /** Short, non-reversible id used to revoke the key. */
  id: string;
  description: string;
  createdAt: string;
  masked: string;
}

// Cloud configuration
export interface Cloud {
  url: string;
}

// Toast notification
export interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
}

// Health check
export interface HealthStatus {
  success: boolean;
  exists?: boolean;
  message?: string;
}

// HLTB times
export interface HLTBTimes {
  mainStory: number; // minutes
  mainExtra: number; // minutes
  completionist: number; // minutes
  source?: string; // source of data (steam, hlbt, community)
  fetchedAt: string; // ISO 8601
}

// Playtime session
export interface PlaytimeSession {
  id: number;
  game: string;
  platform: string;
  sessionStart: string; // ISO 8601
  sessionEnd: string; // ISO 8601
  durationMinutes: number;
  createdAt: string;
  source: 'steam' | 'local'; // source of playtime data
}

// Playtime summary per game
export interface PlaytimeSummary {
  gameId: number;
  game: string;
  platform: string;
  totalMinutes: number;
  totalSessions: number;
  lastPlayed: string | null;
  firstPlayed: string | null;
}

// Achievement
export interface Achievement {
  id: number;
  game: string;
  apiName: string;
  displayName: string;
  description: string;
  unlocked: boolean;
  unlockTime: string | null;
  rarity: number; // percentage (0-100)
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
}

// Achievement detail with full progress info
export interface AchievementDetail {
  id: number;
  game: string;
  apiName: string;
  displayName: string;
  description: string;
  unlocked: boolean;
  unlockTime: string | null;
  rarity: number; // global percentage
  localRarity: number; // user's library percentage
  hidden: boolean;
  iconUrl: string;
  iconGrayUrl: string;
  isSecret: boolean;
  steamApiName: string;
  createdAt: string;
  updatedAt: string;
}

// Rarity tier classification
export type RarityTier = 'common' | 'uncommon' | 'rare' | 'ultra-rare' | 'epic' | 'legendary';

export interface AchievementRarityTier {
  tier: RarityTier;
  minPercent: number; // inclusive
  maxPercent: number; // exclusive
  label: string;
  color: string;
}

export interface AchievementProgress {
  total: number;
  unlocked: number;
  percentage: number;
  rarestUnlocked: AchievementRarityTier | null;
}

export const RARITY_TIERS: AchievementRarityTier[] = [
  { tier: 'legendary', minPercent: 0, maxPercent: 10, label: 'Legendary', color: '#FFD700' },
  { tier: 'epic', minPercent: 10, maxPercent: 20, label: 'Epic', color: '#E945FF' },
  { tier: 'ultra-rare', minPercent: 20, maxPercent: 50, label: 'Ultra Rare', color: '#FF6B00' },
  { tier: 'rare', minPercent: 50, maxPercent: 80, label: 'Rare', color: '#00BFFF' },
  { tier: 'uncommon', minPercent: 80, maxPercent: 95, label: 'Uncommon', color: '#32CD32' },
  { tier: 'common', minPercent: 95, maxPercent: 101, label: 'Common', color: '#888888' },
];

// Playtime graph data for charts
export interface PlaytimeGraphData {
  line: { date: string; minutes: number }[]; // cumulative over time
  bar: { game: string; minutes: number }[]; // per-game
  pie: { game: string; minutes: number; percentage: number }[]; // distribution
  heatmap: { date: string; minutes: number }[]; // calendar heatmap
  area: { date: string; cumulativeMinutes: number }[]; // cumulative area
}

// Playtime comparison data
export interface PlaytimeComparison {
  current: { period: string; totalMinutes: number; sessions: number };
  previous: { period: string; totalMinutes: number; sessions: number };
  difference: { minutes: number; percentage: number; sessions: number };
}

// Playtime summary aggregate
export interface PlaytimeSummaryAggregate {
  totalMinutes: number;
  totalSessions: number;
  gamesPlayed: number;
  averageSessionMinutes: number;
}

// Achievement summary
export interface AchievementSummary {
  game: string;
  total: number;
  unlocked: number;
  percentage: number;
}

// API response wrapper
export interface APIResponse<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
  [key: string]: unknown;
}

// Sync progress
export interface SyncProgress {
  percent: number;
  message: string;
}

// Upload headers
export interface UploadHeaders {
  'x-game': string;
  'x-path': string;
  'x-sync-id'?: string;
}

// Electron IPC API
// Save versioning (Dune)
export interface SaveFileSnapshot {
  versionId: string;
  path: string;
  size: number;
  hash: string;
  mtime: string;
}

export interface SaveVersion {
  id: string;
  gameId: number;
  ownerId?: string;
  deviceId?: string;
  createdAt: string;
  sizeBytes: number;
  fileCount: number;
  parentVersionId?: string;
  changeSummary: string;
  status: 'complete' | 'partial' | 'restored';
}

export interface ConflictRecord {
  id: string;
  gameId: number;
  localVersionId: string;
  remoteVersionId: string;
  detectedAt: string;
  resolution?: 'local' | 'remote' | 'both' | 'later';
  resolvedAt?: string;
}

export interface BackupProfile {
  gameId: number;
  includeGlobs: string[];
  excludeGlobs: string[];
  autoExcludeCache: boolean;
  maxFileSizeMB?: number;
  updatedAt: string;
}

export interface Device {
  id: string;
  ownerId?: string;
  name: string;
  platform: string;
  lastSeen: string;
}

export interface StorageEntry {
  gameId: number;
  installBytes: number;
  saveBytes: number;
  cacheBytes: number;
  lastPlayed: string | null;
  drive: string;
}

export interface PrefixEntry {
  name: string;
  path: string;
  valid?: boolean;
  sizeBytes?: number;
  version?: string;
}

export interface PrefixSummary {
  wine: PrefixEntry[];
  proton: PrefixEntry[];
  heroic: PrefixEntry[];
  lutris: PrefixEntry[];
}

export interface ElectronAPI {
  // Config
  loadConfig: () => Promise<{ games: Game[]; cloud: Cloud; settings: Settings } | null>;
  saveConfig: (config: Partial<{ games: Game[]; cloud: Cloud; settings: Settings }>) => Promise<boolean>;
  
  // Games
  addGame: (game: Omit<Game, 'id'>) => Promise<Game[]>;
  removeGame: (id: number) => Promise<Game[]>;
  autoDetectGames: (roots: string[]) => Promise<{ count: number; currentGames: Game[] }>;
  
  // Sync
  exportSaves: () => Promise<{ success: boolean; path?: string; message?: string }>;
  syncCloud: (creds: { url: string }) => Promise<{ success: boolean; message: string }>;
  restoreCloud: (creds: { url: string }) => Promise<{ success: boolean; message: string }>;
  testCloud: (creds: { url: string }) => Promise<{ success: boolean; message: string }>;
  
  // Art
  fetchArt: (id: number, name: string) => Promise<{ success: boolean; thumbnail?: string; message?: string }>;
  setCustomArt: (id: number) => Promise<string | false>;
  
  // Dialog
  selectDirectory: () => Promise<{ success: boolean; path?: string }>;
  
  // Progress
  onSyncProgress: (cb: (data: { percent: number; message: string }) => void) => () => void;
  
  // Playtime
  recordPlaytime: (session: Omit<PlaytimeSession, 'id' | 'createdAt'>) => Promise<{ success: boolean; message?: string }>;
  onPlaytimeRecorded: (cb: (data: { game: string; durationMinutes: number }) => void) => () => void;
  getPlaytimeSummary: (game?: string) => Promise<{ success: boolean; summary: PlaytimeSummary[]; message?: string }>;
  getRecentSessions: (limit?: number) => Promise<{ success: boolean; sessions: PlaytimeSession[]; message?: string }>;
  getTotalPlaytime: () => Promise<{ success: boolean; totalMinutes: number; message?: string }>;
  getPlaytimeGraphData: (range: 'all' | 'year' | 'month' | 'week' | 'custom', customRange?: { start: string; end: string }) => Promise<{ success: boolean; data: PlaytimeGraphData; message?: string }>;
  getPlaytimeComparison: (range: 'week' | 'month' | 'year') => Promise<{ success: boolean; comparison: PlaytimeComparison; message?: string }>;
  exportPlaytimeData: (format: 'csv' | 'json', range?: 'all' | 'year' | 'month' | 'week' | 'custom', customRange?: { start: string; end: string }) => Promise<{ success: boolean; data: string; message?: string }>;
  
  // Achievements
  getAchievements: (game: string) => Promise<{ success: boolean; achievements: Achievement[]; message?: string }>;
  getAchievementSummary: (game?: string) => Promise<{ success: boolean; summary: AchievementSummary[]; message?: string }>;
  getRecentUnlocks: (limit?: number) => Promise<{ success: boolean; unlocks: Achievement[]; message?: string }>;
  getAchievementDetail: (game: string) => Promise<{ success: boolean; achievements: AchievementDetail[]; progress?: AchievementProgress | null; message?: string }>;
  importLocalAchievements: (game: Game) => Promise<{ success: boolean; count: number; message?: string }>;
  
  // HLTB
  getHLTBTimes: (gameName: string) => Promise<{ success: boolean; times?: HLTBTimes; message?: string; stale?: boolean }>;

  // Launcher
  launchGame: (game: Game, options?: Record<string, unknown>) => Promise<{ success: boolean; message: string; pid?: number }>;
  getLaunchCommand: (game: Game, options?: Record<string, unknown>) => Promise<{ success: boolean; command?: { command: string; args: string[]; env?: Record<string, string>; cwd?: string } | null; message?: string }>;

  // Prefix manager
  listPrefixes: () => Promise<{ success: boolean; prefixes?: PrefixSummary; message?: string }>;
  createPrefix: (prefixPath: string) => Promise<{ success: boolean; message: string }>;
  deletePrefix: (prefixPath: string) => Promise<{ success: boolean; message: string }>;
  backupPrefix: (prefixPath: string) => Promise<{ success: boolean; message: string; backupPath?: string }>;

  // Save versions
  getSaveVersions: (game: string) => Promise<{ success: boolean; versions?: SaveVersion[]; message?: string }>;
  createSaveVersion: (game: string, deviceId?: string, changeSummary?: string) => Promise<{ success: boolean; version?: SaveVersion; conflict?: ConflictRecord | null; hasUnresolved?: boolean; message?: string }>;
  getSaveVersion: (id: string) => Promise<{ success: boolean; version?: SaveVersion; files?: SaveFileSnapshot[]; message?: string }>;
  getSaveVersionDiff: (from: string, to: string) => Promise<{ success: boolean; diff?: { added: string[]; removed: string[]; changed: string[]; unchanged: number }; message?: string }>;
  restoreSaveVersion: (game: string, versionId: string) => Promise<{ success: boolean; message?: string; restoredFiles?: number }>;

  // Conflicts
  getConflicts: (game?: string) => Promise<{ success: boolean; conflicts?: ConflictRecord[]; hasUnresolved?: boolean; message?: string }>;
  detectConflict: (game: string, localVersionId: string, remoteVersionId: string) => Promise<{ success: boolean; conflict?: ConflictRecord | null; hasUnresolved?: boolean; message?: string }>;
  resolveConflict: (id: string, resolution: 'local' | 'remote' | 'both' | 'later') => Promise<{ success: boolean; conflict?: ConflictRecord; message?: string }>;

  // Backup profiles
  getBackupProfile: (game: string) => Promise<{ success: boolean; profile?: BackupProfile; message?: string }>;
  setBackupProfile: (profile: BackupProfile & { game?: string }) => Promise<{ success: boolean; profile?: BackupProfile; message?: string }>;

  // Storage
  getStorage: (game: string) => Promise<{ success: boolean; entry?: StorageEntry; freeBytes?: number; message?: string }>;
  refreshHLTBCache: (gameName?: string) => Promise<{ success: boolean; message?: string }>;
  getHLTBCacheStats: () => Promise<{ success: boolean; stats: { entries: number; oldest: string; newest: string }; message?: string }>;
  
  // AI Analysis
  analyzeFiles: (gameName: string, files: GameFile[]) => Promise<{ success: boolean; analysis?: Record<string, FileAnalysis>; message?: string }>;
  
  // SteamGridDB
  searchArt: (query: string) => Promise<{ success: boolean; results?: string[]; message?: string }>;
  autoMatchAll: () => Promise<{ success: boolean; count: number; message?: string }>;
  
  // Local sync
  triggerLocalSync: () => Promise<{ success: boolean; count: number; games: string[]; message?: string }>;
  getLocalSources: () => Promise<{ success: boolean; sources: LocalSource[]; message?: string }>;
  addLocalSource: (path: string) => Promise<{ success: boolean; source?: LocalSource; message?: string }>;
  removeLocalSource: (id: number) => Promise<{ success: boolean; message?: string }>;
  
  // Remote servers
  getRemoteServers: () => Promise<{ success: boolean; servers: RemoteServer[]; message?: string }>;
  addRemoteServer: (url: string) => Promise<{ success: boolean; server?: RemoteServer; message?: string }>;
  removeRemoteServer: (id: number) => Promise<{ success: boolean; message?: string }>;
  
  // API Keys (self-service: keys belong to the authenticated user)
  getApiKeys: () => Promise<{ success: boolean; keys: ApiKeyInfo[]; message?: string }>;
  addApiKey: (description?: string) => Promise<{ success: boolean; key?: string; message?: string }>;
  removeApiKey: (id: string) => Promise<{ success: boolean; message?: string }>;
  
  // Ollama
  getOllamaModels: (endpoint: string) => Promise<{ success: boolean; models?: string[]; message?: string }>;
  checkOllamaHealth: () => Promise<HealthStatus>;

  // Renderer diagnostics, secret store, and help (client-only bridge methods)
  reportRendererError: (report: { message: string; stack?: string; url?: string }) => Promise<unknown>;
  openErrorLog: () => Promise<unknown>;
  getServerKey: () => Promise<{ success: boolean; key: string }>;
  setServerKey: (key: string) => Promise<{ success: boolean }>;
}

// NOTE: no `declare global Window` here on purpose. This package is a pure
// types module; stamping a global Window.electronAPI would silently override
// the renderer's own bridge declaration (preload.ts is the runtime truth)
// for every importer. Renderers declare their own Window binding instead.
