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
  /** Install folder of the game (set by scanners). Never a save path; saves live in winPath/linPath. */
  installPath?: string;
  /** Emulator command used for ROM entries (for example `retroarch`). */
  emulator?: string;
  /** Absolute ROM path for emulator entries; may differ from linPath. */
  romPath?: string;
  /** DUN-062 managed prefix id chosen for this game; main resolves it to a path at launch (DUN-061). */
  managedPrefixId?: string;
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
  /** DUN-092: the key is write-only (PUT /api/provider-keys/steamgriddb); settings only say whether one is set. */
  steamGridApiKeySet: boolean;
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
  /** Client-only (DUN-028): opt-in app update checks. Default off. */
  updateChecks?: boolean;
  /** Client-only (DUN-077): saved scanner source toggles; written by main via scanner:setSource only. */
  scannerSources?: ScannerSourceToggles;
  /** Remote achievement trackers, each off until the user turns it on. Backend reads the same flags. */
  trackersEnabled?: TrackersEnabled;
  /** SteamGridDB artwork lookups; off until the user turns them on. Backend reads the same flag. */
  artworkEnabled?: boolean;
}

/** Per-tracker opt-in; every field defaults to false. */
export interface TrackersEnabled {
  steam: boolean;
  retroAchievements: boolean;
  gog: boolean;
  epic: boolean;
}

export const DEFAULT_TRACKERS_ENABLED: TrackersEnabled = { steam: false, retroAchievements: false, gog: false, epic: false };

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
  hidden: boolean;
  isSecret: boolean;
  steamApiName: string;
  createdAt: string;
  updatedAt: string;
}

// Rarity tier classification
// 'unknown': no usable global rarity (missing, <= 0 or non-numeric); never counted as rarest (DUN-007).
export type RarityTier = 'common' | 'uncommon' | 'rare' | 'ultra-rare' | 'epic' | 'legendary' | 'unknown';

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
  // DUN-007: no numeric range; only assigned when rarity is <= 0, NaN or not a number.
  { tier: 'unknown', minPercent: 0, maxPercent: 0, label: 'Unknown', color: '#555555' },
];

// Playtime graph data for charts
export interface PlaytimeGraphData {
  line: { date: string; minutes: number }[]; // cumulative over time
  bar: { game: string; minutes: number }[]; // per-game
  pie: { game: string; minutes: number; percentage: number }[]; // distribution
  heatmap: { date: string; minutes: number }[]; // calendar heatmap
  area: { date: string; cumulativeMinutes: number }[]; // cumulative area
  /**
   * DUN-096: what one point covers. 'day' (date = YYYY-MM-DD) for spans up to
   * 366 days; 'month' (date = YYYY-MM-01) for longer 'all' ranges.
   */
  bucket?: 'day' | 'month';
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
  /** The user's own exclude rules (DUN-103); the built-in cache rules are added by autoExcludeCache. */
  excludeGlobs: string[];
  /** When true the server also applies its built-in cache/log/screenshot excludes (GET /api/backup-profile -> cacheExcludeGlobs). */
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
  saveBytes: number;
  cacheBytes: number;
  lastPlayed: string | null;
  drive: string;
}

/** A Wine prefix Dune created itself, recorded in main's prefix registry (DUN-062). */
export interface ManagedPrefix {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  gameId?: string;
}

/** Fixed failure codes for prefix operations. Raw OS messages are logged in main, never returned. */
export type PrefixOpFailureReason =
  | 'not-found'
  | 'not-managed'
  | 'symlink'
  | 'outside-root'
  | 'invalid-name'
  | 'exists'
  | 'in-use'
  | 'trash-failed'
  | 'error';

export type CreatePrefixResult =
  | { ok: true; prefix: ManagedPrefix }
  | { ok: false; reason: Extract<PrefixOpFailureReason, 'invalid-name' | 'exists' | 'outside-root' | 'error'> };

export type BackupPrefixResult =
  | { ok: true; backupPath: string }
  | { ok: false; reason: Extract<PrefixOpFailureReason, 'not-found' | 'not-managed' | 'symlink' | 'outside-root' | 'exists' | 'error'> };

export type DeletePrefixResult =
  | { ok: true; trashedPath: string }
  | { ok: false; reason: Extract<PrefixOpFailureReason, 'not-found' | 'not-managed' | 'symlink' | 'outside-root' | 'trash-failed' | 'error'> };

/** Why a drive's free space could not be read. Raw OS messages are logged in main, never returned. */
export type DriveSpaceUnavailableReason = 'not-found' | 'permission' | 'unsupported' | 'error';

/**
 * Free/total space for one drive (device). `paths` lists every requested folder on that
 * drive in its original requested form, deduped. Unavailable entries are grouped by reason.
 */
export type DriveSpace =
  | { paths: string[]; mount: string; label?: string; status: 'ok'; freeBytes: number; totalBytes: number }
  | { paths: string[]; status: 'unavailable'; reason: DriveSpaceUnavailableReason };

// Game launch (DUN-061): the renderer sends a game id only; main reads the
// executable, args, cwd, launcher and prefix from its own store.
export type LaunchFailureReason = 'not-found' | 'not-launchable' | 'error';
export type LaunchFailure = { ok: false; reason: LaunchFailureReason; message?: string };
export type LaunchResult = { ok: true; pid?: number } | LaunchFailure;
export type LaunchCommandResult =
  | { ok: true; command: { command: string; args: string[]; env?: Record<string, string>; cwd?: string } | { url: string } }
  | LaunchFailure;

// Launch settings (DUN-061): launch fields are main-only. The renderer sends
// metadata or an id; main picks files in its own dialog and validates ids.
export type NewGameInput = { name: string; winPath?: string; linPath?: string; thumbnail?: string; tags?: string[] };
export type AddGameResult = { ok: true; game: Game; games: Game[] } | { ok: false; reason: 'invalid' | 'error' };
export type PickLaunchTargetResult = { ok: true; game: Game } | { ok: false; reason: 'not-found' | 'cancelled' | 'invalid' | 'error' };
export type SetGamePrefixResult = { ok: true; game: Game } | { ok: false; reason: 'not-found' | 'prefix-not-found' | 'error' };
export interface EmulatorInfo { id: string; name: string }
export type SetGameEmulatorResult = { ok: true; game: Game } | { ok: false; reason: 'not-found' | 'unknown-emulator' | 'not-emulator' | 'error' };

// Server-call results (Dune UI contract). Every IPC handler that calls the
// Dune Server resolves to `{ ok: true, ...body }` or a ServerFailure:
// `status` is the HTTP status (absent when no response arrived; then code is
// 'NETWORK'), `code` is the server body's `code` unchanged, `message` the
// server body's `error`. Local pre-checks use codes such as 'NO_SERVER'.
export type ServerFailure = { ok: false; status?: number; code: string; message: string };
export type ServerResult<T extends object = object> = ({ ok: true } & T) | ServerFailure;

/** One failed file or game inside a save sync / restore. */
export interface SyncFailureItem { game: string; path?: string; status?: number; code: string; message: string }
/** Local files a restore replaced, copied to `<userData>/restore-backups` first (DUN-066). */
export interface RestoreBackupInfo { game: string; dir: string; files: string[] }
export type CloudSyncResult =
  | { ok: true; message: string; uploaded?: number; restored?: number; backups?: RestoreBackupInfo[] }
  | (ServerFailure & { failures?: SyncFailureItem[]; backups?: RestoreBackupInfo[] });

export type RemoveGameResult = { ok: true; games: Game[] } | { ok: false; reason: 'invalid' | 'not-found' | 'error' };
export type ImportLocalAchievementsResult = ServerResult<{ success?: boolean; count: number; message?: string }>;

/** game:fetchArt (DUN-092): art found by the server's SteamGridDB provider, saved as a local thumbnail. */
export type FetchArtResult = ServerResult<{ thumbnail: string }>;

/** DUN-092: provider keys are write-only; the server answers `{ set }` only. */
export type ProviderKeyStatusResult = ServerResult<{ set: boolean }>;

/** DUN-073: the local Dune Server API key is write-only too. `unreadable`: stored but can't be decrypted. */
export type ServerKeyStatus = { set: boolean; unreadable?: true };

/** DUN-028: opt-in update checks; download and install only on a click. */
export type UpdateState = 'disabled' | 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
export interface UpdateStatus { state: UpdateState; version?: string; message?: string }

/** DUN-077: scanner sources the user can switch on/off ('manual' is always on). */
export type ScannerSourceId = 'steam' | 'heroic' | 'lutris' | 'epic' | 'gog' | 'ubisoft' | 'ea' | 'battlenet' | 'xbox' | 'minecraft' | 'emulator';
export type ScannerSourceToggles = Partial<Record<ScannerSourceId, boolean>>;
export interface ScannerSourceInfo { id: ScannerSourceId; name: string; enabled: boolean }
export type SetScannerSourceResult = { ok: true; sources: ScannerSourceInfo[] } | { ok: false; reason: 'unknown-source' | 'invalid' };

/** DUN-070: result of a background auto-sync run, sent as the `sync:auto` event. */
export interface AutoSyncEvent { at: string; result: CloudSyncResult }

/** saves:listFiles (DUN-047 enabler): what sync sees for a game before exclude rules. Read-only. */
export interface SaveFileEntry { /** Relative, forward slashes. */ path: string; size: number; mtimeMs: number }
export type SaveFileListResult =
  | { ok: true; files: SaveFileEntry[]; truncated: boolean }
  | { ok: false; code: 'GAME_NOT_FOUND' | 'NO_SAVE_PATH' | 'PROTECTED_SAVE_PATH' | 'LOCAL_ERROR'; message?: string };

/** A Wine/Proton prefix found on disk (read-only; open-folder only, never deleted by Dune). */
export type DiscoveredPrefixSource = 'wine' | 'proton' | 'heroic' | 'lutris';
export interface DiscoveredPrefix { path: string; source: DiscoveredPrefixSource; label?: string }
export type OpenDiscoveredPrefixResult = { ok: true } | { ok: false; reason: 'not-discovered' | 'open-failed' };

export interface ElectronAPI {
  // Config
  loadConfig: () => Promise<{ games: Game[]; cloud: Cloud; settings: Settings } | null>;
  saveConfig: (config: Partial<{ games: Game[]; cloud: Cloud; settings: Settings }>) => Promise<boolean>;
  
  // Games
  addGame: (game: NewGameInput) => Promise<AddGameResult>;
  /** The only way a game leaves the store (config:save never removes games). */
  removeGame: (gameId: number) => Promise<RemoveGameResult>;
  autoDetectGames: (roots: string[]) => Promise<{ count: number; currentGames: Game[] }>;
  
  // Sync
  exportSaves: () => Promise<{ success: boolean; path?: string; message?: string }>;
  syncCloud: (creds: { url: string }) => Promise<CloudSyncResult>;
  restoreCloud: (creds: { url: string }) => Promise<CloudSyncResult>;
  testCloud: (creds: { url: string }) => Promise<ServerResult<{ message: string }>>;
  /** DUN-070: background auto-sync results. */
  onAutoSync: (cb: (event: AutoSyncEvent) => void) => () => void;
  /** Read-only: a game's save files as sync sees them before exclude rules (DUN-047 enabler). */
  listSaveFiles: (gameId: number) => Promise<SaveFileListResult>;
  
  // Art (through the Dune Server's SteamGridDB provider)
  fetchArt: (gameId: number) => Promise<FetchArtResult>;
  setCustomArt: (id: number) => Promise<string | false>;
  
  // Dialog
  selectDirectory: () => Promise<{ success: boolean; path?: string }>;
  
  // Progress
  onSyncProgress: (cb: (data: { percent: number; message: string }) => void) => () => void;
  
  // Playtime
  onPlaytimeRecorded: (cb: (data: { game: string; durationMinutes: number }) => void) => () => void;
  getPlaytimeSummary: (game?: string) => Promise<ServerResult<{ success: boolean; summary: PlaytimeSummary[]; message?: string }>>;
  getRecentSessions: (limit?: number) => Promise<ServerResult<{ success: boolean; sessions: PlaytimeSession[]; message?: string }>>;
  getTotalPlaytime: () => Promise<ServerResult<{ success: boolean; totalMinutes: number; message?: string }>>;
  getPlaytimeGraphData: (range: 'all' | 'year' | 'month' | 'week' | 'custom', customRange?: { start: string; end: string }) => Promise<ServerResult<{ success: boolean; data: PlaytimeGraphData; message?: string }>>;
  getPlaytimeComparison: (range: 'week' | 'month' | 'year') => Promise<ServerResult<{ success: boolean; comparison: PlaytimeComparison; message?: string }>>;
  exportPlaytimeData: (format: 'csv' | 'json', range?: 'all' | 'year' | 'month' | 'week' | 'custom', customRange?: { start: string; end: string }) => Promise<ServerResult<{ success: boolean; data: string; message?: string }>>;
  
  // Achievements
  getAchievementSummary: (game?: string) => Promise<ServerResult<{ success: boolean; summary: AchievementSummary[]; message?: string }>>;
  getRecentUnlocks: (limit?: number) => Promise<ServerResult<{ success: boolean; unlocks: Achievement[]; message?: string }>>;
  getAchievementDetail: (game: string) => Promise<ServerResult<{ success: boolean; achievements: AchievementDetail[]; progress?: AchievementProgress | null; message?: string }>>;
  importLocalAchievements: (gameId: number) => Promise<ImportLocalAchievementsResult>;
  onAchievementsImported: (cb: (data: { game: string; count: number }) => void) => () => void;
  
  // HLTB
  getHLTBTimes: (gameName: string) => Promise<ServerResult<{ success: boolean; times?: HLTBTimes; message?: string; stale?: boolean }>>;

  // Launcher
  launchGame: (gameId: number) => Promise<LaunchResult>;
  getLaunchCommand: (gameId: number) => Promise<LaunchCommandResult>;
  pickLaunchTarget: (gameId: number) => Promise<PickLaunchTargetResult>;
  setGamePrefix: (gameId: number, prefixId: string | null) => Promise<SetGamePrefixResult>;
  listEmulators: () => Promise<EmulatorInfo[]>;
  setGameEmulator: (gameId: number, emulatorId: string | null) => Promise<SetGameEmulatorResult>;

  // Prefix manager (DUN-062): only Dune-managed prefixes, addressed by name (create) or registry id.
  // No method takes a filesystem path from the renderer.
  listPrefixes: () => Promise<ManagedPrefix[]>;
  createPrefix: (name: string) => Promise<CreatePrefixResult>;
  backupPrefix: (id: string) => Promise<BackupPrefixResult>;
  deletePrefix: (id: string) => Promise<DeletePrefixResult>;
  /** Prefixes found on disk (Wine, Proton, Heroic, Lutris). Read-only. */
  discoverPrefixes: () => Promise<DiscoveredPrefix[]>;
  /** Opens a folder only when it is in a fresh discoverPrefixes() result. */
  openDiscoveredPrefix: (path: string) => Promise<OpenDiscoveredPrefixResult>;

  // Scanner sources (DUN-077)
  getScannerSources: () => Promise<ScannerSourceInfo[]>;
  setScannerSource: (id: ScannerSourceId, enabled: boolean) => Promise<SetScannerSourceResult>;

  // Save versions
  getSaveVersions: (gameId: number) => Promise<ServerResult<{ success: boolean; versions?: SaveVersion[]; message?: string }>>;
  restoreSaveVersion: (gameId: number, versionId: string) => Promise<ServerResult<{ success: boolean; message?: string; restoredFiles?: number }>>;

  // Conflicts
  getConflicts: (game?: string) => Promise<ServerResult<{ success: boolean; conflicts?: ConflictRecord[]; hasUnresolved?: boolean; message?: string }>>;
  resolveConflict: (id: string, resolution: 'local' | 'remote' | 'both' | 'later') => Promise<ServerResult<{ success: boolean; conflict?: ConflictRecord; message?: string }>>;

  // Backup profiles
  getBackupProfile: (game: string) => Promise<ServerResult<{ success: boolean; profile?: BackupProfile; message?: string }>>;
  setBackupProfile: (profile: BackupProfile & { game?: string }) => Promise<ServerResult<{ success: boolean; profile?: BackupProfile; message?: string }>>;

  // Storage
  getStorage: (game: string) => Promise<ServerResult<{ success: boolean; entry?: StorageEntry; freeBytes?: number; message?: string }>>;
  
  // AI Analysis
  analyzeFiles: (gameName: string, files: GameFile[]) => Promise<ServerResult<{ success: boolean; analysis?: Record<string, FileAnalysis>; message?: string }>>;
  
  // SteamGridDB
  searchArt: (query: string) => Promise<ServerResult<{ success: boolean; results?: string[]; message?: string }>>;
  autoMatchAll: () => Promise<ServerResult<{ success: boolean; count: number; message?: string }>>;
  /** DUN-092: the server's SteamGridDB key is write-only; these return only { set }. Set/clear need an admin. */
  getSteamGridKeyStatus: () => Promise<ProviderKeyStatusResult>;
  setSteamGridKey: (key: string) => Promise<ProviderKeyStatusResult>;
  clearSteamGridKey: () => Promise<ProviderKeyStatusResult>;
  
  // Local sync
  triggerLocalSync: () => Promise<ServerResult<{ success: boolean; count: number; games: string[]; message?: string }>>;
  getLocalSources: () => Promise<ServerResult<{ success: boolean; sources: LocalSource[]; message?: string }>>;
  addLocalSource: (path: string) => Promise<ServerResult<{ success: boolean; source?: LocalSource; message?: string }>>;
  removeLocalSource: (id: number) => Promise<ServerResult<{ success: boolean; message?: string }>>;
  
  // Remote servers
  getRemoteServers: () => Promise<ServerResult<{ success: boolean; servers: RemoteServer[]; message?: string }>>;
  addRemoteServer: (url: string) => Promise<ServerResult<{ success: boolean; server?: RemoteServer; message?: string }>>;
  removeRemoteServer: (id: number) => Promise<ServerResult<{ success: boolean; message?: string }>>;
  
  // API Keys (self-service: keys belong to the authenticated user)
  getApiKeys: () => Promise<ServerResult<{ success: boolean; keys: ApiKeyInfo[]; message?: string }>>;
  addApiKey: (description?: string) => Promise<ServerResult<{ success: boolean; key?: string; message?: string }>>;
  removeApiKey: (id: string) => Promise<ServerResult<{ success: boolean; message?: string }>>;
  /** DUN-115: the signed-in user; role gates admin-only UI. */
  getCurrentUser(): Promise<ServerResult<{ id: string; name: string; role: 'admin' | 'member' }>>;
  
  // Ollama
  /** DUN-095/057: the server uses its stored endpoint only (admin-only). */
  getOllamaModels: () => Promise<ServerResult<{ success: boolean; models?: string[]; message?: string }>>;
  checkOllamaHealth: () => Promise<ServerResult<HealthStatus>>;

  // Renderer diagnostics, secret store, and help (client-only bridge methods)
  reportRendererError: (report: { message: string; stack?: string; url?: string }) => Promise<unknown>;
  /** DUN-073: write-only; never returns the key. */
  getServerKey: () => Promise<ServerKeyStatus>;
  setServerKey: (key: string) => Promise<ServerKeyStatus>;

  // App updates (DUN-028): opt-in via settings.updateChecks; download/install only on a click
  getUpdateStatus: () => Promise<UpdateStatus>;
  downloadUpdate: () => Promise<UpdateStatus>;
  installUpdate: () => Promise<UpdateStatus>;
  onUpdateStatus: (cb: (status: UpdateStatus) => void) => () => void;

  // Disk space (one entry per drive; never rejects)
  getDiskSpace(paths?: string[]): Promise<DriveSpace[]>;
}

// NOTE: no `declare global Window` here on purpose. This package is a pure
// types module; stamping a global Window.electronAPI would silently override
// the renderer's own bridge declaration (preload.ts is the runtime truth)
// for every importer. Renderers declare their own Window binding instead.

export * from './pathRules.js';
export * from './backupGlob.js';
export * from './serverUrl.js';
