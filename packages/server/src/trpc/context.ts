import { database } from '../db/index.js';
import type { Settings } from '../types/index.js';

export interface TRPCContext {
  db: ReturnType<typeof database.getGames>;
  settings: Settings;
  userId?: string;
}

export async function createContext(): Promise<TRPCContext> {
  return {
    db: database.getGames(),
    settings: database.getSettings(),
  };
}
