import type { CreateHTTPContextOptions } from '@trpc/server/adapters/standalone';
import { database } from '../db/index.js';
import { extractApiKey } from '../utils/authKey.js';
import type { Game, Settings, User } from '../types/index.js';

export interface TRPCContext {
  db: Game[];
  settings: Settings;
  /** Raw key as presented (never logged). */
  apiKey: string | null;
  /** True when the presented key resolves to a user. */
  apiKeyValid: boolean;
  /** The authenticated user, or null for anonymous/health requests. */
  user: User | null;
}

function extractKey(req: CreateHTTPContextOptions['req']): string | null {
  return extractApiKey(
    req.headers as Record<string, string | string[] | undefined>,
    req.url,
  );
}

export async function createContext({ req }: CreateHTTPContextOptions): Promise<TRPCContext> {
  const apiKey = extractKey(req);
  const user = database.resolveUserByKey(apiKey);
  return {
    db: user ? database.getGamesForUser(user) : [],
    settings: database.getSettings(),
    apiKey,
    apiKeyValid: user !== null,
    user,
  };
}
