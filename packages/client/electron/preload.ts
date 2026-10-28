import { contextBridge, ipcRenderer } from 'electron';
import type { AutoSyncEvent, BackupProfile, Game, NewGameInput, ScannerSourceId, UpdateStatus } from '@dune/shared';

interface Cloud {
  url: string;
}

interface Settings {
  runInBackground: boolean;
  autoSyncEnabled: boolean;
  autoSyncFreq: string;
  scanRoots: string[];
  updateChecks?: boolean;
  // Server settings
  maxVersions?: number;
  ollamaEndpoint?: string;
  ollamaModel?: string;
  apiKeys?: string[];
  localSources?: Array<{ id: number; path: string }>;
  remoteServers?: Array<{ id: number; url: string }>;
}

interface PlaytimeSession {
  id: number;
  game: string;
  platform: string;
  sessionStart: string;
  sessionEnd: string;
  durationMinutes: number;
  createdAt: string;
}

contextBridge.exposeInMainWorld('electronAPI', {
  // Config
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (config: Partial<{ games: Game[]; cloud: Cloud; settings: Settings }>) => 
    ipcRenderer.invoke('config:save', config),
  
  // Games
  // DUN-061: metadata only; launch fields are set by main (scanners / pickers below).
  addGame: (game: NewGameInput) => ipcRenderer.invoke('game:add', game),
  // Follow-up (a): the only way to remove a game (config:save never removes).
  removeGame: (gameId: number) => ipcRenderer.invoke('game:remove', gameId),
  autoDetectGames: (customRoots: string[]) => ipcRenderer.invoke('games:autodetect', customRoots),
  
  // Sync
  exportSaves: () => ipcRenderer.invoke('sync:export'),
  syncCloud: (credentials: { url: string }) => ipcRenderer.invoke('sync:cloud', credentials),
  restoreCloud: (credentials: { url: string }) => ipcRenderer.invoke('sync:restore', credentials),
  testCloud: (credentials: { url: string }) => ipcRenderer.invoke('sync:test', credentials),
  // DUN-070: background auto-sync results.
  onAutoSync: (cb: (event: AutoSyncEvent) => void) => {
    const handler = (_: Electron.IpcRendererEvent, event: AutoSyncEvent) => cb(event);
    ipcRenderer.on('sync:auto', handler);
    return () => ipcRenderer.removeListener('sync:auto', handler);
  },
  // Read-only list of a game's save files (what sync sees before excludes).
  listSaveFiles: (gameId: number) => ipcRenderer.invoke('saves:listFiles', gameId),
  
  // Art (through the Dune Server's SteamGridDB provider; game id only)
  fetchArt: (gameId: number) => ipcRenderer.invoke('game:fetchArt', gameId),
  setCustomArt: (id: number) => ipcRenderer.invoke('game:setCustomArt', id),
  
  // Dialog
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
  
  // Progress
  onSyncProgress: (cb: (data: { percent: number; message: string }) => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: { percent: number; message: string }) => cb(data);
    ipcRenderer.on('sync:progress', handler);
    return () => ipcRenderer.removeListener('sync:progress', handler);
  },
  
  // Playtime
  recordPlaytime: (session: Omit<PlaytimeSession, 'id' | 'createdAt'>) => 
    ipcRenderer.invoke('playtime:record', session),
  onPlaytimeRecorded: (cb: (data: { game: string; durationMinutes: number }) => void) => {
    const listener = (_event: unknown, data: { game: string; durationMinutes: number }) => cb(data);
    ipcRenderer.on('playtime:recorded', listener);
    return () => ipcRenderer.removeListener('playtime:recorded', listener);
  },
  getPlaytimeSummary: (game?: string) => 
    ipcRenderer.invoke('playtime:summary', game),
  getRecentSessions: (limit?: number) => 
    ipcRenderer.invoke('playtime:recent', limit),
  getTotalPlaytime: () => 
    ipcRenderer.invoke('playtime:total'),

  getPlaytimeGraphData: (range: 'all' | 'year' | 'month' | 'week' | 'custom', customRange?: { start: string; end: string }) =>
    ipcRenderer.invoke('playtime:graph', range, customRange),
  getPlaytimeComparison: (range: 'week' | 'month' | 'year') =>
    ipcRenderer.invoke('playtime:comparison', range),
  exportPlaytimeData: (format: 'csv' | 'json', range?: 'all' | 'year' | 'month' | 'week' | 'custom', customRange?: { start: string; end: string }) =>
    ipcRenderer.invoke('playtime:export', format, range, customRange),
  
  // Achievements
  getAchievements: (game: string) => 
    ipcRenderer.invoke('achievements:get', game),
  getAchievementDetail: (game: string) =>
    ipcRenderer.invoke('achievements:detail', game),
  getAchievementSummary: (game?: string) => 
    ipcRenderer.invoke('achievements:summary', game),
  getRecentUnlocks: (limit?: number) => 
    ipcRenderer.invoke('achievements:recent', limit),
  // Follow-up (b): a game id only; main reads the game from its store.
  importLocalAchievements: (gameId: number) =>
    ipcRenderer.invoke('achievements:importLocal', gameId),
  onAchievementsImported: (cb: (data: { game: string; count: number }) => void) => {
    const listener = (_event: unknown, data: { game: string; count: number }) => cb(data);
    ipcRenderer.on('achievements:imported', listener);
    return () => ipcRenderer.removeListener('achievements:imported', listener);
  },
  
  // HLTB
  getHLTBTimes: (gameName: string) => 
    ipcRenderer.invoke('hltb:get', gameName),

  // Launcher (DUN-061): game id only; main reads everything else from its store.
  launchGame: (gameId: number) =>
    ipcRenderer.invoke('game:launch', gameId),
  getLaunchCommand: (gameId: number) =>
    ipcRenderer.invoke('game:launchCommand', gameId),
  pickLaunchTarget: (gameId: number) =>
    ipcRenderer.invoke('game:pickLaunchTarget', gameId),
  setGamePrefix: (gameId: number, prefixId: string | null) =>
    ipcRenderer.invoke('game:setPrefix', gameId, prefixId),
  listEmulators: () =>
    ipcRenderer.invoke('emulators:list'),
  setGameEmulator: (gameId: number, emulatorId: string | null) =>
    ipcRenderer.invoke('game:setEmulator', gameId, emulatorId),

  // Prefix manager
  // DUN-062: names/ids only; main builds and checks every path.
  listPrefixes: () =>
    ipcRenderer.invoke('prefix:list'),
  createPrefix: (name: string) =>
    ipcRenderer.invoke('prefix:create', name),
  backupPrefix: (id: string) =>
    ipcRenderer.invoke('prefix:backup', id),
  deletePrefix: (id: string) =>
    ipcRenderer.invoke('prefix:delete', id),
  // Prefixes found on disk: read-only, open-folder only.
  discoverPrefixes: () =>
    ipcRenderer.invoke('prefix:discover'),
  openDiscoveredPrefix: (path: string) =>
    ipcRenderer.invoke('prefix:openDiscovered', path),

  // Scanner sources (DUN-077)
  getScannerSources: () =>
    ipcRenderer.invoke('scanner:getSources'),
  setScannerSource: (id: ScannerSourceId, enabled: boolean) =>
    ipcRenderer.invoke('scanner:setSource', id, enabled),

  // Save versions
  getSaveVersions: (game: string) =>
    ipcRenderer.invoke('saves:listVersions', game),
  createSaveVersion: (game: string, deviceId?: string, changeSummary?: string) =>
    ipcRenderer.invoke('saves:createVersion', game, deviceId, changeSummary),
  getSaveVersion: (id: string) =>
    ipcRenderer.invoke('saves:getVersion', id),
  getSaveVersionDiff: (from: string, to: string) =>
    ipcRenderer.invoke('saves:diff', from, to),
  restoreSaveVersion: (game: string, versionId: string) =>
    ipcRenderer.invoke('saves:restore', game, versionId),

  // Conflicts
  getConflicts: (game?: string) =>
    ipcRenderer.invoke('conflicts:list', game),
  detectConflict: (game: string, localVersionId: string, remoteVersionId: string) =>
    ipcRenderer.invoke('conflicts:detect', game, localVersionId, remoteVersionId),
  resolveConflict: (id: string, resolution: 'local' | 'remote' | 'both' | 'later') =>
    ipcRenderer.invoke('conflicts:resolve', id, resolution),

  // Backup profiles
  getBackupProfile: (game: string) =>
    ipcRenderer.invoke('backupProfile:get', game),
  setBackupProfile: (profile: BackupProfile & { game?: string }) =>
    ipcRenderer.invoke('backupProfile:set', profile),

  // Storage
  getStorage: (game: string) =>
    ipcRenderer.invoke('storage:get', game),
  
  // AI Analysis
  analyzeFiles: (gameName: string, files: Array<{ path: string; size: number; category: string }>) => 
    ipcRenderer.invoke('ai:analyze', { gameName, files }),
  
  // SteamGridDB
  searchArt: (query: string) => 
    ipcRenderer.invoke('art:search', query),
  autoMatchAll: () => 
    ipcRenderer.invoke('art:auto-match'),
  // DUN-092: write-only server key; { set } only.
  getSteamGridKeyStatus: () =>
    ipcRenderer.invoke('steamGridKey:status'),
  setSteamGridKey: (key: string) =>
    ipcRenderer.invoke('steamGridKey:set', key),
  clearSteamGridKey: () =>
    ipcRenderer.invoke('steamGridKey:clear'),
  
  // Local sync
  triggerLocalSync: () => 
    ipcRenderer.invoke('local-sync:trigger'),
  getLocalSources: () => 
    ipcRenderer.invoke('local-sources:get'),
  addLocalSource: (path: string) => 
    ipcRenderer.invoke('local-sources:add', path),
  removeLocalSource: (id: number) => 
    ipcRenderer.invoke('local-sources:remove', id),
  
  // Remote servers
  getRemoteServers: () => 
    ipcRenderer.invoke('remote-servers:get'),
  addRemoteServer: (url: string) => 
    ipcRenderer.invoke('remote-servers:add', url),
  removeRemoteServer: (id: number) => 
    ipcRenderer.invoke('remote-servers:remove', id),
  
  // API Keys (self-service: issues and revokes keys for the signed-in user)
  getApiKeys: () => 
    ipcRenderer.invoke('api-keys:get'),
  addApiKey: (description?: string) => 
    ipcRenderer.invoke('api-keys:add', { description }),
  removeApiKey: (id: string) => 
    ipcRenderer.invoke('api-keys:remove', id),
  
  // Ollama
  // DUN-095/057: the server uses its stored endpoint; none is sent.
  getOllamaModels: () =>
    ipcRenderer.invoke('ollama:models'),
  checkOllamaHealth: () => 
    ipcRenderer.invoke('ollama:health'),

  // Diagnostics
  reportRendererError: (report: { message: string; stack?: string; url?: string }) =>
    ipcRenderer.invoke('reportRendererError', report),
  openErrorLog: () =>
    ipcRenderer.invoke('openErrorLog'),

  // Server API key (DUN-073: write-only; get returns { set, unreadable? })
  getServerKey: () =>
    ipcRenderer.invoke('server-key:get'),
  setServerKey: (key: string) =>
    ipcRenderer.invoke('server-key:set', key),

  // App updates (DUN-028)
  getUpdateStatus: () =>
    ipcRenderer.invoke('updates:status'),
  downloadUpdate: () =>
    ipcRenderer.invoke('updates:download'),
  installUpdate: () =>
    ipcRenderer.invoke('updates:install'),
  onUpdateStatus: (cb: (status: UpdateStatus) => void) => {
    const handler = (_: Electron.IpcRendererEvent, status: UpdateStatus) => cb(status);
    ipcRenderer.on('updates:status', handler);
    return () => ipcRenderer.removeListener('updates:status', handler);
  },

  // Disk space
  getDiskSpace: (paths?: string[]) =>
    ipcRenderer.invoke('system:diskSpace', paths),
});