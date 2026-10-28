/**
 * Ludusavi save-path manifest for the server (FEAT-server-manifest): a thin
 * adapter over @dune/providers' manifest provider. The server supplies the
 * opt-in flag (Settings.manifestEnabled must be exactly true), the axios
 * transport, a file cache (<DATA_DIR>/manifest-cache/ludusavi-manifest.json;
 * file mtime = stored time) and pino. The provider keeps the last good copy
 * in memory, revalidates with ETag/304 and falls back to the cached copy.
 *
 * Not to be confused with ./manifest.ts (the delta-sync content-hash manifest
 * of a game's uploaded files).
 *
 * The data is PCGamingWiki content (CC BY-NC-SA 3.0): every answer carries
 * MANIFEST_ATTRIBUTION. Paths in an entry are data with Ludusavi placeholders;
 * this module never expands, resolves or touches them.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  createManifestProvider, MANIFEST_TIMEOUT_MS,
  type CacheEntry, type CachedManifest, type ManifestAttribution, type ManifestGame, type ManifestProvider, type ManifestQuery, type ProviderCache,
} from '@dune/providers';
import { database } from '../db/index.js';
import { STORE_ID_PATTERN } from '../schemas.js';
import type { Game } from '../types/index.js';
import { ApiError } from '../utils/apiError.js';
import { dataDir } from '../utils/path.js';
import { logger, redactText } from '../middleware/logging.js';
import { axiosTransport } from './providerTransport.js';

/** One manifest game plus its canonical (PCGamingWiki) title. */
export type ManifestEntry = ManifestGame & { title: string };

export interface ManifestLookup {
  entry: ManifestEntry;
  pageUrl: string;
  attribution: ManifestAttribution;
  stale: boolean;
}

export function manifestCacheDir(): string {
  return path.join(dataDir(), 'manifest-cache');
}

/** Cache keys come from the provider; anything outside [a-z0-9-] is refused rather than turned into a path. */
function cacheFile(key: string): string {
  if (!/^[a-z0-9-]{1,64}$/.test(key)) throw new Error('invalid manifest cache key');
  return path.join(manifestCacheDir(), `${key}.json`);
}

function logCacheError(op: string, err: unknown): void {
  logger.warn({ provider: 'manifest', op, message: redactText(err instanceof Error ? err.message : String(err)) }, 'Manifest cache error');
}

function isCachedManifest(v: unknown): v is CachedManifest {
  const m = v as Partial<CachedManifest> | null;
  return Boolean(m && typeof m === 'object' && m.games && typeof m.games === 'object' && !Array.isArray(m.games)
    && typeof m.fetchedAt === 'number' && typeof m.skipped === 'number' && (m.etag === undefined || typeof m.etag === 'string'));
}

/** File-backed ProviderCache. A read error (or an unreadable file) is a logged miss; a write error is logged. Writes are atomic (temp file + rename). */
export const manifestFileCache: ProviderCache<CachedManifest> = {
  get(key: string): CacheEntry<CachedManifest> | null {
    try {
      const file = cacheFile(key);
      if (!fs.existsSync(file)) return null;
      const storedAt = fs.statSync(file).mtimeMs;
      const value: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (!isCachedManifest(value)) {
        logCacheError('cache-read', new Error('unexpected cache shape'));
        return null;
      }
      return { value, storedAt };
    } catch (err) {
      logCacheError('cache-read', err);
      return null;
    }
  },
  set(key: string, value: CachedManifest): void {
    try {
      const file = cacheFile(key);
      fs.mkdirSync(manifestCacheDir(), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(value), 'utf-8');
      fs.renameSync(tmp, file);
    } catch (err) {
      logCacheError('cache-write', err);
    }
  },
};

/** Opt-in: only Settings.manifestEnabled === true lets a lookup (or a cache read) happen. */
export function manifestEnabled(): boolean {
  return database.getSettings().manifestEnabled === true;
}

const disabled = (): ApiError => new ApiError(403, 'PROVIDER_DISABLED', 'Save-path manifest lookups are disabled (Settings.manifestEnabled)');

/** Route guard: 403 PROVIDER_DISABLED ({error, code}) before anything else happens. */
export function requireManifestEnabled(): void {
  if (!manifestEnabled()) throw disabled();
}

/** The server's provider wiring. Exported so tests can build a fresh instance (empty in-memory copy). */
export function createServerManifestProvider(now?: () => number): ManifestProvider {
  return createManifestProvider({
    transport: axiosTransport,
    enabled: manifestEnabled,
    cache: manifestFileCache,
    logger,
    timeoutMs: MANIFEST_TIMEOUT_MS,
    ...(now ? { now } : {}),
  });
}

/** Created once: the in-memory last-good copy and the parsed index live for the process. */
const defaultProvider = createServerManifestProvider();

/** A stored store id as the manifest's number key; anything not a canonical digit string is ignored (never guessed). */
function storeIdNumber(id: string | null | undefined): number | undefined {
  return typeof id === 'string' && STORE_ID_PATTERN.test(id) ? Number(id) : undefined;
}

/**
 * FEAT-server-storeIds: the manifest query for one game row. findManifestGame
 * tries the Steam id, then the GOG id, then the title, so every known id is
 * passed and the title is always the last resort.
 */
export function manifestQueryForGame(game: Pick<Game, 'name' | 'steamAppId' | 'gogId'>): ManifestQuery {
  const steamId = storeIdNumber(game.steamAppId);
  const gogId = storeIdNumber(game.gogId);
  return {
    title: game.name,
    ...(steamId !== undefined ? { steamId } : {}),
    ...(gogId !== undefined ? { gogId } : {}),
  };
}

const unavailable = (): ApiError => new ApiError(503, 'MANIFEST_UNAVAILABLE', 'The save-path manifest is unavailable');

/**
 * Manifest entry for a query (Steam id, then GOG id, then title; see
 * findManifestGame). Disabled -> 403 PROVIDER_DISABLED, no entry -> 404
 * MANIFEST_NOT_FOUND, download/parse failure with no cached copy -> 503
 * MANIFEST_UNAVAILABLE.
 */
export async function lookupManifest(query: ManifestQuery, provider: ManifestProvider = defaultProvider): Promise<ManifestLookup> {
  let r: Awaited<ReturnType<ManifestProvider['lookup']>>;
  try {
    r = await provider.lookup(query);
  } catch (err) {
    logger.warn({ provider: 'manifest', message: redactText(err instanceof Error ? err.message : String(err)) }, 'Manifest lookup failed');
    throw unavailable();
  }
  if (r.ok) {
    const { title, game, pageUrl, attribution } = r.value;
    return { entry: { title, ...game }, pageUrl, attribution, stale: r.stale === true };
  }
  if (r.code === 'PROVIDER_DISABLED') throw disabled();
  if (r.code === 'PROVIDER_NOT_FOUND') throw new ApiError(404, 'MANIFEST_NOT_FOUND', 'Game not found in the save-path manifest');
  logger.warn({ provider: 'manifest', code: r.code, message: redactText(r.message) }, 'Manifest lookup failed');
  throw unavailable();
}
