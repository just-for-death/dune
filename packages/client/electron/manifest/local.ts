/**
 * Local (no server / unreachable server) Ludusavi manifest lookup: @dune/providers'
 * manifest provider over the local transport, cached in <userData>/provider-cache
 * (namespace "manifest"). The provider's own TTL is 7 days; the disk cache keeps
 * entries 30 days so a stale copy can be served when a refresh fails.
 * No Electron import: main passes net.fetch and the userData dir.
 */
import { createManifestProvider, type CachedManifest, type ManifestMatch, type ManifestQuery, type ProviderLogger, type ProviderResult } from '@dune/providers';
import { createDiskCache } from '../providers/diskCache';
import { createLocalTransport, type FetchLike } from '../providers/transport';
import { DAY_MS } from '../providers/localProviders';
import type { MaybePromise } from '../providers/types';

export const MANIFEST_DISK_CACHE = { namespace: 'manifest', ttlMs: 30 * DAY_MS, maxBytes: 96 * 1024 * 1024 } as const;

export interface LocalManifestOptions {
  userDataDir: string;
  fetch: FetchLike;
  /** Settings.manifestEnabled, read on every call. */
  enabled: () => MaybePromise<boolean>;
  now?: () => number;
  logger?: ProviderLogger;
}

export type LocalManifestLookup = (query: ManifestQuery) => Promise<ProviderResult<ManifestMatch>>;

export function createLocalManifestLookup(opts: LocalManifestOptions): LocalManifestLookup {
  const cache = createDiskCache({ userDataDir: opts.userDataDir, ...MANIFEST_DISK_CACHE, ...(opts.now ? { now: opts.now } : {}) });
  const provider = createManifestProvider({
    transport: createLocalTransport(opts.fetch),
    enabled: async () => (await opts.enabled()) === true,
    cache: cache.asProviderCache<CachedManifest>(),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  return (query) => provider.lookup(query);
}
