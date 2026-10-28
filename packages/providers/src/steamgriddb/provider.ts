import { codeForStatus, failure, isProviderError, success, type ProviderResult } from '../core/errors.js';
import { gated, resolveKey } from '../core/gating.js';
import { createGuardedClient, isHostAllowed } from '../core/guard.js';
import { checkImageResponse, DEFAULT_IMAGE_MAX_BYTES, type CheckedImage } from '../core/image.js';
import { noopLogger, type EnabledSource, type HttpResponse, type HttpTransport, type KeySource, type ProviderLogger } from '../core/types.js';

export const STEAMGRIDDB_API_BASE = 'https://www.steamgriddb.com/api/v2';
/** API calls (and the Bearer key) only ever go here. */
export const STEAMGRIDDB_API_HOSTS = ['www.steamgriddb.com'] as const;
/** Image downloads only from the SteamGridDB CDN; the key is never sent there. */
export const STEAMGRIDDB_IMAGE_HOSTS = ['cdn2.steamgriddb.com', 'cdn.steamgriddb.com'] as const;
export const STEAMGRIDDB_GRID_DIMENSIONS = '600x900,460x215,920x430';
/** API JSON bodies are small; images are capped separately (DUN-027). */
const API_MAX_BYTES = 2 * 1024 * 1024;
export const STEAMGRIDDB_AUTOMATCH_DELAY_MS = 300;

export interface SteamGridGame { id: number; name: string }

export interface SteamGridDbProviderOptions {
  transport: HttpTransport;
  enabled: EnabledSource;
  key: KeySource;
  logger?: ProviderLogger;
  timeoutMs?: number;
  imageMaxBytes?: number;
}

export interface AutoMatchOptions {
  /** Pause between games (rate limit courtesy). Default 300 ms. */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface AutoMatchOutcome {
  matched: Array<{ name: string; thumbnail: string }>;
  /** Per-game failures (redacted messages); a disabled/missing-key provider stops the run instead. */
  errors: Array<{ game: string; code: string; message: string }>;
}

export interface SteamGridDbProvider {
  /** Best autocomplete match, or null when SteamGridDB has none. */
  searchGame(query: string): Promise<ProviderResult<SteamGridGame | null>>;
  /** Grid image URLs for a game, restricted to https CDN URLs on STEAMGRIDDB_IMAGE_HOSTS. */
  getGrids(gameId: number): Promise<ProviderResult<string[]>>;
  /** searchGame + getGrids; [] when the game is unknown. */
  searchArt(query: string): Promise<ProviderResult<string[]>>;
  /** First grid for each game without a thumbnail. */
  autoMatch(games: ReadonlyArray<{ name: string; thumbnail: string }>, opts?: AutoMatchOptions): Promise<ProviderResult<AutoMatchOutcome>>;
  /** DUN-027: download one image from the CDN allow-list; png/jpeg/webp only, size-capped, magic bytes checked. */
  downloadImage(url: string): Promise<ProviderResult<CheckedImage>>;
}

function apiData(res: HttpResponse, what: string): ProviderResult<unknown[]> {
  if (res.status !== 200) return failure(codeForStatus(res.status), `SteamGridDB ${what} failed (status ${res.status})`);
  const body = res.data as { success?: unknown; data?: unknown } | null;
  if (!body || typeof body !== 'object' || body.success !== true) return failure('PROVIDER_BAD_RESPONSE', `SteamGridDB ${what}: unexpected response`);
  return success(Array.isArray(body.data) ? body.data : []);
}

/** https, no credentials/port, CDN host only. */
export function isAllowedImageUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password && (u.port === '' || u.port === '443') && isHostAllowed(u.hostname, STEAMGRIDDB_IMAGE_HOSTS);
  } catch {
    return false;
  }
}

/**
 * SteamGridDB v2 (artwork). Gated: nothing (not even the key lookup) runs
 * unless `enabled()` is exactly true. The key is read per call from the
 * injected KeySource, sent only as a Bearer header to the API host, and
 * scrubbed from every logged or returned message.
 */
export function createSteamGridDbProvider(opts: SteamGridDbProviderOptions): SteamGridDbProvider {
  const logger = opts.logger ?? noopLogger;
  let liveKey: string | null = null;
  const common = { provider: 'steamgriddb' as const, transport: opts.transport, logger, secrets: () => [liveKey], ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) };
  const api = createGuardedClient({ ...common, hosts: STEAMGRIDDB_API_HOSTS, maxBytes: API_MAX_BYTES });
  const cdn = createGuardedClient({ ...common, hosts: STEAMGRIDDB_IMAGE_HOSTS, maxBytes: opts.imageMaxBytes ?? DEFAULT_IMAGE_MAX_BYTES });

  async function withKey<T>(fn: (key: string) => Promise<ProviderResult<T>>): Promise<ProviderResult<T>> {
    const k = await resolveKey('steamgriddb', opts.key);
    if (!k.ok) return k;
    liveKey = k.key;
    return fn(k.key);
  }

  const get = (path: string, key: string) =>
    api.request(`${STEAMGRIDDB_API_BASE}${path}`, { headers: { Authorization: `Bearer ${key}` }, responseType: 'json' });

  async function searchGameKeyed(query: string, key: string): Promise<ProviderResult<SteamGridGame | null>> {
    const r = apiData(await get(`/search/autocomplete/${encodeURIComponent(query)}`, key), 'search');
    if (!r.ok) return r;
    const first = r.value[0] as { id?: unknown; name?: unknown } | undefined;
    if (!first) return success(null);
    if (typeof first.id !== 'number' || !Number.isInteger(first.id) || typeof first.name !== 'string') return failure('PROVIDER_BAD_RESPONSE', 'SteamGridDB search: unexpected game shape');
    return success({ id: first.id, name: first.name });
  }

  async function getGridsKeyed(gameId: number, key: string): Promise<ProviderResult<string[]>> {
    if (!Number.isInteger(gameId) || gameId <= 0) return failure('PROVIDER_NOT_FOUND', 'SteamGridDB game id must be a positive integer');
    const r = apiData(await get(`/grids/game/${gameId}?dimensions=${STEAMGRIDDB_GRID_DIMENSIONS}`, key), 'grids');
    if (!r.ok) return r;
    const urls = r.value.map((g) => (g as { url?: unknown } | null)?.url);
    const allowed = urls.filter(isAllowedImageUrl);
    if (allowed.length < urls.length) logger.warn({ provider: 'steamgriddb', op: 'grids', dropped: urls.length - allowed.length }, 'SteamGridDB grid URLs outside the CDN allow-list dropped');
    return success(allowed);
  }

  async function searchArtKeyed(query: string, key: string): Promise<ProviderResult<string[]>> {
    const game = await searchGameKeyed(query, key);
    if (!game.ok) return game;
    return game.value ? getGridsKeyed(game.value.id, key) : success([]);
  }

  const run = <T>(fn: (key: string) => Promise<ProviderResult<T>>) => gated('steamgriddb', opts.enabled, () => withKey(fn));

  return {
    searchGame: (query) => run((key) => searchGameKeyed(query, key)),
    getGrids: (gameId) => run((key) => getGridsKeyed(gameId, key)),
    searchArt: (query) => run((key) => searchArtKeyed(query, key)),

    autoMatch: (games, o = {}) => run(async (key) => {
      const delayMs = o.delayMs ?? STEAMGRIDDB_AUTOMATCH_DELAY_MS;
      const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      const out: AutoMatchOutcome = { matched: [], errors: [] };
      let first = true;
      for (const game of games) {
        if (game.thumbnail) continue;
        if (!first && delayMs > 0) await sleep(delayMs);
        first = false;
        let r: ProviderResult<string[]>;
        try {
          r = await searchArtKeyed(game.name, key);
        } catch (err) {
          // The guarded client already redacted and logged it.
          r = isProviderError(err) ? failure(err.code, err.message) : failure('PROVIDER_UNAVAILABLE', 'SteamGridDB request failed');
        }
        if (r.ok) {
          if (r.value[0]) out.matched.push({ name: game.name, thumbnail: r.value[0] });
        } else {
          // A bad/revoked key fails every game the same way: stop instead of hammering the API.
          if (r.code === 'PROVIDER_KEY_MISSING') return r;
          out.errors.push({ game: game.name, code: r.code, message: r.message });
        }
      }
      return success(out);
    }),

    downloadImage: (url) => gated('steamgriddb', opts.enabled, async () => {
      if (!isAllowedImageUrl(url)) return failure('PROVIDER_HOST_BLOCKED', 'image URL is not on the SteamGridDB CDN');
      const res = await cdn.request(url, { responseType: 'bytes' });
      return checkImageResponse(res, { maxBytes: opts.imageMaxBytes ?? DEFAULT_IMAGE_MAX_BYTES });
    }),
  };
}
