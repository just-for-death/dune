import { isFresh } from '../core/cache.js';
import { codeForStatus, failure, isProviderError, success, type ProviderErrorCode, type ProviderFailure, type ProviderResult } from '../core/errors.js';
import { gated } from '../core/gating.js';
import { createGuardedClient } from '../core/guard.js';
import { noopLogger, type CacheEntry, type EnabledSource, type HttpTransport, type ProviderCache, type ProviderLogger } from '../core/types.js';
import { buildManifestIndex, findManifestGame, pcgamingwikiPageUrl, type ManifestIndex, type ManifestQuery } from './lookup.js';
import { parseManifestYaml } from './parse.js';
import type { ManifestGame } from './schema.js';

/** Fixed source (providers design: "Save-path manifest"). Not configurable on purpose. */
export const LUDUSAVI_MANIFEST_URL = 'https://raw.githubusercontent.com/mtkennerly/ludusavi-manifest/master/data/manifest.yaml';
export const MANIFEST_HOSTS = ['raw.githubusercontent.com'] as const;
export const MANIFEST_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Upstream is about 17 MiB (2026-10); default cap leaves headroom, hard limit stops a caller raising it without bound. */
export const MANIFEST_DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
export const MANIFEST_MAX_BYTES_LIMIT = 64 * 1024 * 1024;
export const MANIFEST_TIMEOUT_MS = 60_000;
/** Back-off after a failed refresh before the next network attempt (forced calls skip it). */
export const MANIFEST_RETRY_MS = 15 * 60 * 1000;
const MAX_ETAG_CHARS = 256;
const YAML_TYPES = new Set(['text/plain', 'text/yaml', 'text/x-yaml', 'application/yaml', 'application/x-yaml', 'application/octet-stream']);

export interface ManifestAttribution {
  /** Show this text (with `url` and `licenseUrl` as links) wherever manifest data is shown. */
  text: string;
  /** PCGamingWiki, the original source. */
  url: string;
  license: string;
  licenseUrl: string;
  /** The compiled manifest that is downloaded. */
  manifestUrl: string;
}

/**
 * PCGamingWiki content is CC BY-NC-SA 3.0 (wiki footer and
 * https://www.pcgamingwiki.com/wiki/PCGamingWiki:Copyrights); the Ludusavi
 * manifest is compiled from it. Caching is allowed (PCGamingWiki:API asks
 * clients to cache on their side) as long as the data carries attribution.
 */
export const MANIFEST_ATTRIBUTION: Readonly<ManifestAttribution> = Object.freeze({
  text: 'Save and config locations from the Ludusavi Manifest, compiled from PCGamingWiki. PCGamingWiki content is available under CC BY-NC-SA 3.0.',
  url: 'https://www.pcgamingwiki.com/',
  license: 'CC BY-NC-SA 3.0',
  licenseUrl: 'https://creativecommons.org/licenses/by-nc-sa/3.0/',
  manifestUrl: 'https://github.com/mtkennerly/ludusavi-manifest',
});

/** What the cache stores (JSON-serialisable, no attribution: that is added on every read). */
export interface CachedManifest {
  games: Record<string, ManifestGame>;
  skipped: number;
  /** Epoch ms of the last successful download or 304 revalidation. */
  fetchedAt: number;
  etag?: string;
}

export interface Manifest extends CachedManifest {
  attribution: ManifestAttribution;
}

export interface ManifestMatch {
  /** Canonical manifest title (after following an alias). */
  title: string;
  game: ManifestGame;
  /** PCGamingWiki article for this game (link it next to the attribution). */
  pageUrl: string;
  attribution: ManifestAttribution;
}

export interface ManifestProviderOptions {
  transport: HttpTransport;
  /** Read on every call; anything but `true` -> PROVIDER_DISABLED with zero requests. */
  enabled: EnabledSource;
  cache?: ProviderCache<CachedManifest>;
  ttlMs?: number;
  retryMs?: number;
  now?: () => number;
  logger?: ProviderLogger;
  timeoutMs?: number;
  /** YAML byte cap (default 32 MiB, at most 64 MiB). */
  maxBytes?: number;
  maxGames?: number;
}

export interface ManifestProvider {
  /** The whole validated manifest (cached `ttlMs`, revalidated with ETag; stale cache on failure). */
  getManifest(opts?: { force?: boolean }): Promise<ProviderResult<Manifest>>;
  /** One game by Steam id, GOG id or title. Missing -> PROVIDER_NOT_FOUND. */
  lookup(query: ManifestQuery): Promise<ProviderResult<ManifestMatch>>;
}

const CACHE_KEY = 'ludusavi-manifest';
type Loaded = { value: CachedManifest; stale: boolean };

/**
 * Ludusavi save-path manifest provider. GET of one fixed raw.githubusercontent.com
 * URL through the guarded client (https, allow-listed host, every redirect hop
 * re-checked), YAML parsed with js-yaml CORE_SCHEMA and validated with Zod.
 * Nothing from the manifest is executed; `launch` entries are dropped.
 */
export function createManifestProvider(opts: ManifestProviderOptions): ManifestProvider {
  const maxBytes = opts.maxBytes ?? MANIFEST_DEFAULT_MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > MANIFEST_MAX_BYTES_LIMIT) throw new TypeError(`maxBytes must be an integer in 1..${MANIFEST_MAX_BYTES_LIMIT}`);
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? MANIFEST_CACHE_TTL_MS;
  const retryMs = opts.retryMs ?? MANIFEST_RETRY_MS;
  const logger = opts.logger ?? noopLogger;
  const client = createGuardedClient({ provider: 'manifest', hosts: MANIFEST_HOSTS, transport: opts.transport, logger, maxBytes, timeoutMs: opts.timeoutMs ?? MANIFEST_TIMEOUT_MS });
  /** Last good copy in memory, so a lookup does not re-read (or re-index) a large cache entry. */
  let current: { entry: CacheEntry<CachedManifest>; index?: ManifestIndex } | null = null;
  /** After a failed refresh, wait before hitting the network again (unless forced). */
  let lastFailure: { at: number; result: ProviderFailure } | null = null;
  let inflight: Promise<ProviderResult<Loaded>> | null = null;

  async function readCache(): Promise<CacheEntry<CachedManifest> | null> {
    try {
      return (await opts.cache?.get(CACHE_KEY)) ?? null;
    } catch {
      return null;
    }
  }

  async function writeCache(value: CachedManifest): Promise<void> {
    try {
      await opts.cache?.set(CACHE_KEY, value);
    } catch {
      logger.warn({ provider: 'manifest', op: 'cache-write' }, 'Manifest cache write failed');
    }
  }

  async function download(cached: CachedManifest | null): Promise<ProviderResult<CachedManifest>> {
    const headers: Record<string, string> = { Accept: 'text/plain, application/yaml', 'User-Agent': 'Dune-Manifest (+https://github.com/just-for-death/dune)' };
    if (cached?.etag) headers['If-None-Match'] = cached.etag;
    const res = await client.request(LUDUSAVI_MANIFEST_URL, { headers, responseType: 'text' });
    if (res.status === 304 && cached) return success({ ...cached, fetchedAt: now() });
    if (res.status !== 200) {
      const code: ProviderErrorCode = res.status === 401 || res.status === 403 ? 'PROVIDER_UNAVAILABLE' : codeForStatus(res.status);
      return failure(code, `manifest request failed (status ${res.status})`);
    }
    const type = (res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (type && !YAML_TYPES.has(type)) return failure('PROVIDER_BAD_CONTENT_TYPE', `manifest: unexpected content-type ${type.slice(0, 64)}`);
    if (typeof res.data !== 'string') return failure('PROVIDER_BAD_RESPONSE', 'manifest: expected text');
    const parsed = parseManifestYaml(res.data, { maxBytes, ...(opts.maxGames !== undefined ? { maxGames: opts.maxGames } : {}) });
    const etag = res.headers['etag'];
    logger.info({ provider: 'manifest', games: Object.keys(parsed.games).length, skipped: parsed.skipped }, 'Manifest downloaded');
    return success({ ...parsed, fetchedAt: now(), ...(etag && etag.length <= MAX_ETAG_CHARS ? { etag } : {}) });
  }

  async function load(force: boolean): Promise<ProviderResult<Loaded>> {
    const t = now();
    if (!force && current && isFresh(current.entry, ttlMs, t)) return success({ value: current.entry.value, stale: false });
    const cached = current?.entry ?? (await readCache());
    if (cached && !force && isFresh(cached, ttlMs, t)) {
      current = { entry: cached };
      return success({ value: cached.value, stale: false });
    }
    if (!force && lastFailure && t - lastFailure.at < retryMs) return cached ? success({ value: cached.value, stale: true }) : lastFailure.result;
    let r: ProviderResult<CachedManifest>;
    try {
      r = await download(cached?.value ?? null);
    } catch (err) {
      if (!cached) {
        lastFailure = { at: t, result: isProviderError(err) ? failure(err.code, err.message) : failure('PROVIDER_UNAVAILABLE', 'manifest request failed') };
        throw err;
      }
      r = failure('PROVIDER_UNAVAILABLE', 'manifest request failed');
    }
    if (r.ok) {
      lastFailure = null;
      await writeCache(r.value);
      current = { entry: { value: r.value, storedAt: now() } };
      return success({ value: r.value, stale: false });
    }
    lastFailure = { at: t, result: r };
    if (cached) {
      logger.warn({ provider: 'manifest', code: r.code }, 'Manifest refresh failed, serving cached copy');
      return success({ value: cached.value, stale: true });
    }
    return r;
  }

  /** Concurrent callers share one download (the manifest is large). */
  function loadOnce(force: boolean): Promise<ProviderResult<Loaded>> {
    if (!inflight) inflight = load(force).finally(() => { inflight = null; });
    return inflight;
  }

  function indexFor(m: CachedManifest): ManifestIndex {
    if (current && current.entry.value === m) return (current.index ??= buildManifestIndex(m.games));
    return buildManifestIndex(m.games);
  }

  const attribution = (): ManifestAttribution => ({ ...MANIFEST_ATTRIBUTION });

  return {
    getManifest: (o = {}) => gated('manifest', opts.enabled, async () => {
      const r = await loadOnce(o.force === true);
      if (!r.ok) return r;
      return success({ ...r.value.value, attribution: attribution() }, r.value.stale);
    }),
    lookup: (query) => gated('manifest', opts.enabled, async () => {
      const r = await loadOnce(false);
      if (!r.ok) return r;
      const m = r.value.value;
      const hit = findManifestGame(m.games, indexFor(m), query);
      if (!hit) return failure('PROVIDER_NOT_FOUND', 'game not in manifest');
      return success({ title: hit.name, game: hit.game, pageUrl: pcgamingwikiPageUrl(hit.name), attribution: attribution() }, r.value.stale);
    }),
  };
}
