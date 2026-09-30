import { contextBridge, ipcRenderer } from 'electron';

interface Game {
  id: number;
  name: string;
  winPath: string;
  linPath: string;
  lastSync: string;
  status: string;
  thumbnail: string;
  analysis?: Record<string, FileAnalysis>;
  createdAt?: string;
  updatedAt?: string;
}

interface FileAnalysis {
  category: 'Save' | 'Config' | 'Cache' | 'Other';
  description: string;
}

interface Cloud {
  url: string;
}

interface Settings {
  runInBackground: boolean;
  autoSyncEnabled: boolean;
  autoSyncFreq: string;
  steamGridDbKey: string;
  scanRoots: string[];
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
  addGame: (game: Omit<Game, 'id'>) => ipcRenderer.invoke('game:add', game),
  removeGame: (id: number) => ipcRenderer.invoke('game:remove', id),
  autoDetectGames: (customRoots: string[]) => ipcRenderer.invoke('games:autodetect', customRoots),
  
  // Sync
  exportSaves: () => ipcRenderer.invoke('sync:export'),
  syncCloud: (credentials: { url: string }) => ipcRenderer.invoke('sync:cloud', credentials),
  restoreCloud: (credentials: { url: string }) => ipcRenderer.invoke('sync:restore', credentials),
  testCloud: (credentials: { url: string }) => ipcRenderer.invoke('sync:test', credentials),
  
  // Art
  fetchArt: (id: number, name: string) => ipcRenderer.invoke('game:fetchArt', id, name),
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
  getPlaytimeSummary: (game?: string) => 
    ipcRenderer.invoke('playtime:summary', game),
  getRecentSessions: (limit?: number) => 
    ipcRenderer.invoke('playtime:recent', limit),
  getTotalPlaytime: () => 
    ipcRenderer.invoke('playtime:total'),
  
  // Achievements
  getAchievements: (game: string) => 
    ipcRenderer.invoke('achievements:get', game),
  getAchievementSummary: (game?: string) => 
    ipcRenderer.invoke('achievements:summary', game),
  getRecentUnlocks: (limit?: number) => 
    ipcRenderer.invoke('achievements:recent', limit),
  
  // HLTB
  getHLTBTimes: (gameName: string) => 
    ipcRenderer.invoke('hltb:get', gameName),
  
  // AI Analysis
  analyzeFiles: (gameName: string, files: Array<{ path: string; size: number; category: string }>) => 
    ipcRenderer.invoke('ai:analyze', { gameName, files }),
  
  // SteamGridDB
  searchArt: (query: string) => 
    ipcRenderer.invoke('art:search', query),
  autoMatchAll: () => 
    ipcRenderer.invoke('art:auto-match'),
  
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
  
  // API Keys
  getApiKeys: () => 
    ipcRenderer.invoke('api-keys:get'),
  addApiKey: (key: string, description?: string) => 
    ipcRenderer.invoke('api-keys:add', { key, description }),
  removeApiKey: (key: string) => 
    ipcRenderer.invoke('api-keys:remove', key),
  
  // Ollama
  getOllamaModels: (endpoint: string) => 
    ipcRenderer.invoke('ollama:models', endpoint),
  checkOllamaHealth: () => 
    ipcRenderer.invoke('ollama:health'),
});