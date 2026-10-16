import type { CreateHTTPContextOptions } from '@trpc/server/adapters/standalone';
import { database } from '../db/index.js';
import { extractApiKey } from '../utils/authKey.js';
import type { Settings } from '../types/index.js';

export interface TRPCContext {
  db: ReturnType<typeof database.getGames>;
  settings: Settings;
  /** Raw key as presented (never logged). */
  apiKey: string | null;
  /** True when the presented key validates against stored hashes. */
  apiKeyValid: boolean;
  userId?: string;
}

function extractKey(req: CreateHTTPContextOptions['req']): string | null {
  return extractApiKey(
    req.headers as Record<string, string | string[] | undefined>,
    req.url,
  );
}

export async function createContext({ req }: CreateHTTPContextOptions): Promise<TRPCContext> {
  const apiKey = extractKey(req);
  return {
    db: database.getGames(),
    settings: database.getSettings(),
    apiKey,
    apiKeyValid: database.isValidApiKey(apiKey),
  };
}
