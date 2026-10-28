/**
 * Server adapter over @dune/providers' SteamGridDB provider (FEAT-providers-2a).
 * Owns only what is server-specific: the opt-in flag (Settings.artworkEnabled
 * must be exactly true), the axios transport, pino logging and the legacy
 * route contract. The key comes from providerKeys (withSteamGridKey) per call
 * and is never stored, logged or returned here.
 */
import { createSteamGridDbProvider, type ProviderFailure, type SteamGridDbProvider } from '@dune/providers';
import { database } from '../db/index.js';
import { logger, redactText } from '../middleware/logging.js';
import { ApiError } from '../utils/apiError.js';
import { axiosTransport } from './providerTransport.js';

export interface SteamGridDBResponse {
  success: boolean;
  results?: string[];
  message?: string;
}

/** Opt-in: only Settings.artworkEnabled === true lets any SteamGridDB request happen. */
export function artworkEnabled(): boolean {
  return database.getSettings().artworkEnabled === true;
}

/** Route guard: 403 PROVIDER_DISABLED ({error, code}) before the key is even read. */
export function requireArtworkEnabled(): void {
  if (!artworkEnabled()) throw new ApiError(403, 'PROVIDER_DISABLED', 'SteamGridDB artwork is disabled (Settings.artworkEnabled)');
}

function provider(apiKey: string): SteamGridDbProvider {
  return createSteamGridDbProvider({ transport: axiosTransport, enabled: artworkEnabled, key: () => apiKey, logger });
}

/** DUN-092: messages are already redacted by the provider; scrub again in case. */
function safeMessage(r: ProviderFailure, apiKey: string): string {
  return redactText(apiKey ? r.message.split(apiKey).join('[REDACTED]') : r.message);
}

function failed(r: ProviderFailure, apiKey: string, fields: Record<string, unknown>, msg: string): void {
  if (r.code === 'PROVIDER_DISABLED') requireArtworkEnabled();
  logger.warn({ err: safeMessage(r, apiKey), code: r.code, ...fields }, msg);
}

export async function searchGame(apiKey: string, query: string): Promise<{ id: number; name: string } | null> {
  const r = await provider(apiKey).searchGame(query);
  if (r.ok) return r.value;
  failed(r, apiKey, { query }, 'SteamGridDB search failed');
  return null;
}

export async function getGridImages(apiKey: string, gameId: number): Promise<string[]> {
  const r = await provider(apiKey).getGrids(gameId);
  if (r.ok) return r.value;
  failed(r, apiKey, { gameId }, 'SteamGridDB grids failed');
  return [];
}

/** Route contract unchanged: lookup failures still answer { success: true, results: [] } (and are logged). */
export async function searchArt(apiKey: string, query: string): Promise<SteamGridDBResponse> {
  const r = await provider(apiKey).searchArt(query);
  if (r.ok) return { success: true, results: r.value };
  failed(r, apiKey, { query }, 'SteamGridDB search failed');
  return { success: true, results: [] };
}

/** First CDN grid for each game without a thumbnail (300 ms between games). */
export async function autoMatchAll(apiKey: string, games: Array<{ name: string; thumbnail: string }>): Promise<Array<{ name: string; thumbnail: string }>> {
  const r = await provider(apiKey).autoMatch(games);
  if (!r.ok) {
    failed(r, apiKey, {}, 'SteamGridDB auto-match failed');
    return [];
  }
  if (r.value.errors.length > 0) {
    logger.warn({ errors: r.value.errors.map((e) => ({ game: e.game, code: e.code, error: redactText(e.message.split(apiKey).join('[REDACTED]')) })) }, 'Some games failed auto-match');
  }
  return r.value.matched;
}
