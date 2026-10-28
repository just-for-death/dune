import {
  createHltbProvider,
  createSteamGridDbProvider,
  createUpdateCheckProvider,
  isAllowedImageUrl,
  type CachedRelease,
  type FetchLike,
  type HltbTimes,
  type ProviderLogger,
  type ProviderResult,
  type UpdateCheckProvider,
  type UpdateInfo,
} from '@dune/providers';
import { createDiskCache, type DiskCache } from './diskCache';
import { createLocalKeyStore, type KeyStatus } from './keyStore';
import { createLocalTransport } from './transport';
import { localFailure, type LocalFailure, type LocalFlagsSource, type LocalProviderFlags, type LocalResult, type SecretCrypto } from './types';

/**
 * Local mode (no Dune Server): Electron main calls the public providers
 * directly through @dune/providers. Every lookup reads the flags first; a
 * disabled provider answers PROVIDER_DISABLED with zero network, zero key
 * reads and zero cache reads.
 */
export const DAY_MS = 24 * 60 * 60 * 1000;
/** Retention > the provider TTLs (HLTB 30 d, updates 6 h) so stale fallback works. */
export const CACHE_LIMITS = {
  hltb: { ttlMs: 90 * DAY_MS, maxBytes: 8 * 1024 * 1024 },
  artwork: { ttlMs: 30 * DAY_MS, maxBytes: 256 * 1024 * 1024 },
  updates: { ttlMs: 7 * DAY_MS, maxBytes: 1024 * 1024 },
} as const;
export const MAX_QUERY_LENGTH = 200;

export interface LocalProvidersOptions {
  userDataDir: string;
  fetch: FetchLike;
  crypto: SecretCrypto;
  flags: LocalFlagsSource;
  /** Running app version (app.getVersion()), needed for update checks. */
  appVersion?: string;
  logger?: ProviderLogger;
  now?: () => number;
  warn?: (message: string) => void;
}

/** Renderer-facing HLTB shape (matches @dune/shared HLTBTimes: minutes + ISO fetchedAt). */
export interface LocalHltbTimes { mainStory: number; mainExtra: number; completionist: number; source?: string; fetchedAt: string }

export interface LocalProviders {
  setKey(provider: unknown, key: unknown): Promise<LocalResult<{ set: true }>>;
  clearKey(provider: unknown): Promise<LocalResult<{ set: false }>>;
  getKeyStatus(provider: unknown): Promise<LocalResult<KeyStatus>>;
  getHltbTimes(title: unknown): Promise<LocalResult<{ times: LocalHltbTimes; stale?: true }>>;
  searchArt(query: unknown): Promise<LocalResult<{ results: string[] }>>;
  /** Main-only (bytes never go to the renderer): one SteamGridDB CDN image, cached on disk. */
  downloadArt(url: unknown): Promise<LocalResult<{ bytes: Uint8Array; contentType: string; cached: boolean }>>;
  /**
   * Release check. `trigger: 'manual'` (a user click) always runs; `'auto'` (the default,
   * so a forgotten trigger never bypasses the opt-in) only when updateCheckEnabled is on.
   */
  checkForUpdates(opts?: { force?: boolean; trigger?: 'manual' | 'auto' }): Promise<LocalResult<{ update: UpdateInfo; stale?: true }>>;
  /** Drop every cached provider response and image (keys are kept). */
  clearCache(): Promise<LocalResult<{ cleared: true }>>;
}

type FlagName = keyof LocalProviderFlags;

function fromProvider(res: Extract<ProviderResult<unknown>, { ok: false }>): LocalFailure {
  return localFailure(res.code, res.message);
}

function cleanText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.normalize('NFKC').trim();
  return s.length > 0 && s.length <= MAX_QUERY_LENGTH ? s : null;
}

export function createLocalProviders(opts: LocalProvidersOptions): LocalProviders {
  const now = opts.now ?? Date.now;
  const transport = createLocalTransport(opts.fetch);
  const keys = createLocalKeyStore({ userDataDir: opts.userDataDir, crypto: opts.crypto, ...(opts.warn ? { warn: opts.warn } : {}) });
  const logger = opts.logger;

  const flag = (name: FlagName) => async (): Promise<boolean> => {
    try {
      const f: LocalProviderFlags | null | undefined = await opts.flags();
      return f?.[name] === true;
    } catch {
      return false;
    }
  };
  const hltbOn = flag('hltbEnabled');
  const artOn = flag('artworkEnabled');
  const autoUpdatesOn = flag('updateCheckEnabled');
  const disabled = (what: string) => localFailure('PROVIDER_DISABLED', `${what} is disabled`);

  const caches: Record<keyof typeof CACHE_LIMITS, DiskCache> = {
    hltb: createDiskCache({ userDataDir: opts.userDataDir, namespace: 'hltb', now, ...CACHE_LIMITS.hltb }),
    artwork: createDiskCache({ userDataDir: opts.userDataDir, namespace: 'artwork', now, ...CACHE_LIMITS.artwork }),
    updates: createDiskCache({ userDataDir: opts.userDataDir, namespace: 'updates', now, ...CACHE_LIMITS.updates }),
  };

  const hltb = createHltbProvider({ transport, enabled: hltbOn, cache: caches.hltb.asProviderCache<HltbTimes>(), now, ...(logger ? { logger } : {}) });
  const sgdb = createSteamGridDbProvider({ transport, enabled: artOn, key: keys.keySource('steamgriddb'), ...(logger ? { logger } : {}) });

  // Two instances over one disk cache: manual (always enabled) and automatic (opt-in).
  const updates: Partial<Record<'manual' | 'auto', UpdateCheckProvider | null>> = {};
  const updateProvider = (trigger: 'manual' | 'auto'): UpdateCheckProvider | null => {
    if (updates[trigger] !== undefined) return updates[trigger] ?? null;
    try {
      updates[trigger] = createUpdateCheckProvider({
        transport, enabled: trigger === 'manual' ? () => true : autoUpdatesOn, currentVersion: opts.appVersion ?? '',
        cache: caches.updates.asProviderCache<CachedRelease>(), now, ...(logger ? { logger } : {}),
      });
    } catch {
      updates[trigger] = null;
    }
    return updates[trigger] ?? null;
  };

  return {
    setKey: keys.setKey,
    clearKey: keys.clearKey,
    getKeyStatus: keys.getKeyStatus,

    async getHltbTimes(title) {
      if (!(await hltbOn())) return disabled('HowLongToBeat');
      const t = cleanText(title);
      if (!t) return localFailure('INVALID_INPUT', 'A game title is required');
      const res = await hltb.getTimes(t);
      if (!res.ok) return fromProvider(res);
      const v = res.value;
      const times: LocalHltbTimes = {
        mainStory: v.mainStory, mainExtra: v.mainExtra, completionist: v.completionist,
        ...(v.source ? { source: v.source } : {}),
        fetchedAt: v.fetchedAt ?? new Date(now()).toISOString(),
      };
      return res.stale ? { ok: true, times, stale: true } : { ok: true, times };
    },

    async searchArt(query) {
      if (!(await artOn())) return disabled('Artwork');
      const q = cleanText(query);
      if (!q) return localFailure('INVALID_INPUT', 'A search term is required');
      const res = await sgdb.searchArt(q);
      return res.ok ? { ok: true, results: res.value } : fromProvider(res);
    },

    async downloadArt(url) {
      if (!(await artOn())) return disabled('Artwork');
      if (!isAllowedImageUrl(url)) return localFailure('PROVIDER_HOST_BLOCKED', 'Image URL is not on the SteamGridDB CDN allow-list');
      const hit = await caches.artwork.getBytes(url);
      if (hit) return { ok: true, bytes: hit.bytes, contentType: hit.contentType, cached: true };
      const res = await sgdb.downloadImage(url);
      if (!res.ok) return fromProvider(res);
      await caches.artwork.setBytes(url, res.value.bytes, res.value.contentType);
      return { ok: true, bytes: res.value.bytes, contentType: res.value.contentType, cached: false };
    },

    async checkForUpdates(o) {
      const trigger = o?.trigger === 'manual' ? 'manual' : 'auto';
      if (trigger === 'auto' && !(await autoUpdatesOn())) return disabled('Automatic update checks');
      const p = updateProvider(trigger);
      if (!p) return localFailure('INVALID_INPUT', 'The app version is not a valid SemVer version');
      const res = await p.check(o?.force === true ? { force: true } : undefined);
      if (!res.ok) return fromProvider(res);
      return res.stale ? { ok: true, update: res.value, stale: true } : { ok: true, update: res.value };
    },

    async clearCache() {
      await Promise.all(Object.values(caches).map((c) => c.clear()));
      return { ok: true, cleared: true };
    },
  };
}
