// Core domain types

export interface Game {
  id: number;
  name: string;
  status: 'In Sync' | 'Pending Upload' | 'Error';
  lastSync: string; // ISO 8601
  thumbnail: string;
  analysis?: Record<string, FileAnalysis>;
  /** Owning user id. Every game has exactly one owner (DUN-087). */
  ownerId: string;
  /** FEAT-server-storeIds: Steam app id (digit string) or null when unknown. */
  steamAppId?: string | null;
  /** FEAT-server-storeIds: GOG product id (digit string) or null when unknown. */
  gogId?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Store ids a client may send for a game; an absent key keeps the stored value. */
export interface GameStoreIds {
  steamAppId?: string;
  gogId?: string;
}

export type UserRole = 'admin' | 'member';

export interface User {
  id: string;
  name: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

/** A hashed API key bound to a user. Plaintext keys are never stored. */
export interface ApiKeyRecord {
  hash: string;
  userId: string;
  description: string;
  createdAt: string;
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
  ollamaEndpoint: string;
  ollamaModel: string;
  apiKeys: string[]; // Valid API keys for authentication
  localSources: LocalSource[];
  remoteServers: RemoteServer[];
  /** Opt-in HowLongToBeat lookups; off (false) by default. Only `=== true` enables. */
  hltbEnabled: boolean;
  /** Opt-in SteamGridDB artwork lookups; off (false) by default. Only `=== true` enables. */
  artworkEnabled: boolean;
  /** Opt-in Ludusavi manifest (PCGamingWiki save paths) lookups; off (false) by default. Only `=== true` enables. */
  manifestEnabled: boolean;
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
  'x-steam-app-id'?: string;
  'x-gog-id'?: string;
}

export interface APIResponse<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
  [key: string]: unknown;
}
