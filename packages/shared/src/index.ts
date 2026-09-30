// Shared types for Dune Client ↔ Server communication

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
}

// Playtime summary
export interface PlaytimeSummary {
  game: string;
  platform: string;
  totalMinutes: number;
  totalSessions: number;
  lastPlayed: string | null;
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
  rarity: number;
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
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
  getPlaytimeSummary: (game?: string) => Promise<{ success: boolean; summary: PlaytimeSummary[] }>;
  getRecentSessions: (limit?: number) => Promise<{ success: boolean; sessions: PlaytimeSession[] }>;
  getTotalPlaytime: () => Promise<{ success: boolean; totalMinutes: number }>;
  
  // Achievements
  getAchievements: (game: string) => Promise<{ success: boolean; achievements: Achievement[] }>;
  getAchievementSummary: (game?: string) => Promise<{ success: boolean; summary: AchievementSummary[] }>;
  getRecentUnlocks: (limit?: number) => Promise<{ success: boolean; unlocks: Achievement[] }>;
  
  // HLTB
  getHLTBTimes: (gameName: string) => Promise<{ success: boolean; times?: HLTBTimes; message?: string }>;
  
  // AI Analysis
  analyzeFiles: (gameName: string, files: GameFile[]) => Promise<{ success: boolean; analysis?: Record<string, FileAnalysis>; message?: string }>;
  
  // SteamGridDB
  searchArt: (query: string) => Promise<{ success: boolean; results?: string[]; message?: string }>;
  autoMatchAll: () => Promise<{ success: boolean; count: number; message?: string }>;
  
  // Local sync
  triggerLocalSync: () => Promise<{ success: boolean; count: number; games: string[] }>;
  getLocalSources: () => Promise<{ success: boolean; sources: LocalSource[] }>;
  addLocalSource: (path: string) => Promise<{ success: boolean; source?: LocalSource; message?: string }>;
  removeLocalSource: (id: number) => Promise<{ success: boolean }>;
  
  // Remote servers
  getRemoteServers: () => Promise<{ success: boolean; servers: RemoteServer[] }>;
  addRemoteServer: (url: string) => Promise<{ success: boolean; server?: RemoteServer; message?: string }>;
  removeRemoteServer: (id: number) => Promise<{ success: boolean }>;
  
  // API Keys
  getApiKeys: () => Promise<{ success: boolean; keys: string[] }>;
  addApiKey: (key: string, description?: string) => Promise<{ success: boolean }>;
  removeApiKey: (key: string) => Promise<{ success: boolean }>;
  
  // Ollama
  getOllamaModels: (endpoint: string) => Promise<{ success: boolean; models?: string[]; message?: string }>;
  checkOllamaHealth: () => Promise<HealthStatus>;
}

// Extend Window
declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
