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
  sourceId?: string; // 'steam' | 'heroic' | 'lutris' | 'manual'
  source?: 'steam' | 'heroic' | 'lutris' | 'manual';
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
  getAchievementDetail: (game: string) => Promise<{ success: boolean; achievements: AchievementDetail[]; message?: string }>;
  
  // HLTB
  getHLTBTimes: (gameName: string) => Promise<{ success: boolean; times?: HLTBTimes; message?: string }>;
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
