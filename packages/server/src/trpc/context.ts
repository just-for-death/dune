import type { CreateHTTPContextOptions } from '@trpc/server/adapters/standalone';
import { database } from '../db/index.js';
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

function extractApiKey(req: CreateHTTPContextOptions['req']): string | null {
  const header = req.headers['x-api-key'];
  if (typeof header === 'string' && header.length > 0) return header;
  if (Array.isArray(header) && header.length > 0) return header[0];
  // Support ?api_key= for browser-driven dashboard fetches
  const url = req.url || '';
  const qIndex = url.indexOf('?');
  if (qIndex >= 0) {
    try {
      const params = new URLSearchParams(url.slice(qIndex + 1));
      const q = params.get('api_key');
      if (q) return q;
    } catch {
      return null;
    }
  }
  return null;
}

export async function createContext({ req }: CreateHTTPContextOptions): Promise<TRPCContext> {
  const apiKey = extractApiKey(req);
  return {
    db: database.getGames(),
    settings: database.getSettings(),
    apiKey,
    apiKeyValid: database.isValidApiKey(apiKey),
  };
}
