// Core domain types

export interface Game {
  id: number;
  name: string;
  status: 'In Sync' | 'Pending Upload' | 'Error';
  lastSync: string; // ISO 8601
  thumbnail: string;
  analysis?: Record<string, FileAnalysis>;
  createdAt: string;
  updatedAt: string;
}

export interface FileAnalysis {
  category: 'Save' | 'Config' | 'Cache' | 'Other';
  description: string;
}

export interface GameFile {
  path: string;
  name: string;
  size: number;
  modified: string; // ISO 8601
  category: 'Save' | 'Config' | 'Cache' | 'Other';
}

export interface Version {
  id: string; // timestamp
  timestamp: string; // ISO 8601
}

export interface Settings {
  maxVersions: number;
  steamGridApiKey: string;
  ollamaEndpoint: string;
  ollamaModel: string;
  apiKeys: string[]; // Valid API keys for authentication
  localSources: LocalSource[];
  remoteServers: RemoteServer[];
}

export interface LocalSource {
  id: number;
  path: string;
}

export interface RemoteServer {
  id: number;
  url: string;
}

export interface DBData {
  games: Game[];
  settings: Settings;
}

export interface UploadHeaders {
  'x-game': string;
  'x-path': string;
  'x-sync-id'?: string;
}

export interface APIResponse<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
  [key: string]: unknown;
}

export interface SyncProgress {
  percent: number;
  message: string;
}
