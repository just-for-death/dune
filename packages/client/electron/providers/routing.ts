/**
 * Server-vs-local routing for provider IPC (pure logic, no Electron import).
 *
 * Rules (PL + Jane, 2026-10-28):
 * 1. No server configured: local providers, gated on the LOCAL flag
 *    (hltbEnabled for HLTB, artworkEnabled for art). Off -> PROVIDER_DISABLED, no I/O.
 * 2. Server configured: call the server; the SERVER flag decides and the local
 *    flag is not consulted. Only an unreachable server (code 'NETWORK' and no
 *    `status`; timeouts map to NETWORK) falls back to local, still gated on the
 *    local flag. Any answer with a status (401, 403, PROVIDER_DISABLED, 5xx, ...)
 *    passes through unchanged.
 * 3. SteamGridDB key: no server -> local key store (status only); server -> server path, no fallback.
 * 4. Update checks are local-only and sit beside electron-updater. A manual check
 *    (checkForUpdates, a click) ALWAYS runs; the automatic one (autoCheckForUpdates)
 *    only when updateCheckEnabled is on (PL ruling 2026-10-28).
 *
 * Result shapes match the existing IPC channels (hltb:get, art:search,
 * game:fetchArt, steamGridKey:*), so main.ts can swap handlers without UI changes.
 * New providers (e.g. the save-path manifest) reuse `routeServerFirst` with
 * their own flag; nothing is pre-built for them here.
 */
import type { ElectronAPI, FetchArtResult, HLTBTimes, ProviderKeyStatusResult, ServerFailure, ServerResult, UpdateInfo } from '@dune/shared';
import type { UpdateInfo as ProviderUpdateInfo } from '@dune/providers';
import type { LocalProviders } from './localProviders';
import type { LocalFailure, LocalProviderFlags, MaybePromise } from './types';

export type HltbIpcResult = ServerResult<{ success: boolean; times?: HLTBTimes; message?: string; stale?: boolean }>;
export type SearchArtIpcResult = ServerResult<{ success: boolean; results?: string[]; message?: string }>;
/** Exactly the shared ElectronAPI.checkForUpdates result. */
export type UpdateCheckIpcResult = Awaited<ReturnType<ElectronAPI['checkForUpdates']>>;

/** The game a fetchArt call is about (main resolves id -> game; failures pass through). */
export type ResolvedGame = { ok: true; id: number; name: string } | ServerFailure;

/** Server-side calls, each resolving to a ServerResult (never rejecting). */
export interface ServerProviderCalls {
  getHltbTimes(gameName: unknown): Promise<HltbIpcResult>;
  searchArt(query: unknown): Promise<SearchArtIpcResult>;
  fetchArt(game: { id: number; name: string }): Promise<FetchArtResult>;
  getSteamGridKeyStatus(): Promise<ProviderKeyStatusResult>;
  setSteamGridKey(key: unknown): Promise<ProviderKeyStatusResult>;
  clearSteamGridKey(): Promise<ProviderKeyStatusResult>;
}

export interface ProviderRoutingDeps {
  server: ServerProviderCalls;
  local: LocalProviders;
  /** The configured Dune Server base URL, or null for local mode. */
  getServerUrl(): string | null;
  /** Local Settings flags (hltbEnabled / artworkEnabled / updateCheckEnabled via isUpdateCheckEnabled); only `true` enables. */
  getLocalSettings(): MaybePromise<LocalProviderFlags | null | undefined>;
  /** Resolve a game id from IPC (parse, look up); a failure is returned as-is. */
  resolveGame(id: unknown): Promise<ResolvedGame>;
  /** Save downloaded art for a game; returns the thumbnail reference (e.g. `local://<path>`). */
  saveArt(gameId: number, ext: string, bytes: Uint8Array): MaybePromise<string>;
  /** The running app version (shared UpdateInfo.current). */
  appVersion: string;
}

export interface RoutedProviders {
  getHltbTimes(gameName: unknown): Promise<HltbIpcResult>;
  searchArt(query: unknown): Promise<SearchArtIpcResult>;
  fetchArt(id: unknown): Promise<FetchArtResult>;
  getSteamGridKeyStatus(): Promise<ProviderKeyStatusResult>;
  setSteamGridKey(key: unknown): Promise<ProviderKeyStatusResult>;
  clearSteamGridKey(): Promise<ProviderKeyStatusResult>;
  /** Manual (user click): always runs. */
  checkForUpdates(opts?: unknown): Promise<UpdateCheckIpcResult>;
  /** Automatic (startup/background): PROVIDER_DISABLED unless updateCheckEnabled. */
  autoCheckForUpdates(): Promise<UpdateCheckIpcResult>;
}

export const DISABLED_MESSAGES = {
  hltbEnabled: 'HowLongToBeat lookups are turned off in Settings.',
  artworkEnabled: 'Artwork lookups are turned off in Settings.',
  updateCheckEnabled: 'Automatic update checks are turned off in Settings.',
} as const satisfies Record<keyof LocalProviderFlags, string>;

export function disabledFailure(flag: keyof LocalProviderFlags): ServerFailure {
  return { ok: false, code: 'PROVIDER_DISABLED', message: DISABLED_MESSAGES[flag] };
}

/** True only for "the server could not be reached": NETWORK with no HTTP status. */
export function isServerUnreachable(res: unknown): boolean {
  if (!res || typeof res !== 'object') return false;
  const r = res as { ok?: unknown; status?: unknown; code?: unknown };
  return r.ok === false && r.code === 'NETWORK' && r.status === undefined;
}

function toServerFailure(f: LocalFailure): ServerFailure {
  return f.status === undefined ? { ok: false, code: f.code, message: f.message } : { ok: false, status: f.status, code: f.code, message: f.message };
}

async function flagOn(deps: Pick<ProviderRoutingDeps, 'getLocalSettings'>, flag: keyof LocalProviderFlags): Promise<boolean> {
  try {
    return (await deps.getLocalSettings())?.[flag] === true;
  } catch {
    return false;
  }
}

/**
 * The routing core, reusable by later providers (manifest, trackers):
 * server configured -> server, with a local fallback only when unreachable;
 * no server -> local. Local always runs behind `flag`.
 */
export async function routeServerFirst<R>(
  deps: Pick<ProviderRoutingDeps, 'getServerUrl' | 'getLocalSettings'>,
  flag: keyof LocalProviderFlags,
  server: () => Promise<R>,
  local: () => Promise<R | ServerFailure>,
): Promise<R | ServerFailure> {
  const runLocal = async () => ((await flagOn(deps, flag)) ? local() : disabledFailure(flag));
  if (deps.getServerUrl() === null) return runLocal();
  const res = await server();
  return isServerUnreachable(res) ? runLocal() : res;
}

const EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

/** @dune/providers' release info -> shared UpdateInfo (latest -> version, url -> releaseUrl). */
export function toSharedUpdateInfo(info: ProviderUpdateInfo, current: string): UpdateInfo {
  return {
    version: info.latest,
    current,
    releaseUrl: info.url,
    notes: info.notes,
    isNewer: info.isNewer,
    ...(info.publishedAt !== undefined ? { publishedAt: info.publishedAt } : {}),
  };
}

export function createProviderRouting(deps: ProviderRoutingDeps): RoutedProviders {
  const localHltb = async (gameName: unknown): Promise<HltbIpcResult> => {
    const r = await deps.local.getHltbTimes(gameName);
    if (!r.ok) return toServerFailure(r);
    return r.stale ? { ok: true, success: true, times: r.times, stale: true } : { ok: true, success: true, times: r.times };
  };

  const localSearch = async (query: unknown): Promise<SearchArtIpcResult> => {
    const r = await deps.local.searchArt(query);
    return r.ok ? { ok: true, success: true, results: r.results } : toServerFailure(r);
  };

  const localFetchArt = async (game: { id: number; name: string }): Promise<FetchArtResult> => {
    const found = await deps.local.searchArt(game.name);
    if (!found.ok) return toServerFailure(found);
    const url = found.results[0];
    if (!url) return { ok: false, code: 'ART_NOT_FOUND', message: 'No cover art found on SteamGridDB.' };
    const img = await deps.local.downloadArt(url);
    if (!img.ok) return toServerFailure(img);
    const ext = EXT[img.contentType];
    if (!ext) return { ok: false, code: 'ART_NOT_IMAGE', message: 'The downloaded art is not an image.' };
    try {
      return { ok: true, thumbnail: await deps.saveArt(game.id, ext, img.bytes) };
    } catch {
      return { ok: false, code: 'LOCAL_ERROR', message: 'Could not save the artwork.' };
    }
  };

  const keyStatus = (r: Awaited<ReturnType<LocalProviders['getKeyStatus']>>): ProviderKeyStatusResult =>
    // Exactly { ok, set }: never the key, never extra fields.
    (r.ok ? { ok: true, set: r.set === true } : toServerFailure(r));

  const local = () => deps.getServerUrl() === null;

  const updateCheck = async (o: { force?: boolean; trigger: 'manual' | 'auto' }): Promise<UpdateCheckIpcResult> => {
    const r = await deps.local.checkForUpdates(o);
    if (!r.ok) return toServerFailure(r);
    const update = toSharedUpdateInfo(r.update, deps.appVersion);
    return r.stale ? { ok: true, update, stale: true } : { ok: true, update };
  };

  return {
    getHltbTimes: (gameName) => routeServerFirst(deps, 'hltbEnabled', () => deps.server.getHltbTimes(gameName), () => localHltb(gameName)),

    searchArt: (query) => routeServerFirst(deps, 'artworkEnabled', () => deps.server.searchArt(query), () => localSearch(query)),

    async fetchArt(id) {
      // No server and art off: refuse before even looking the game up.
      if (local() && !(await flagOn(deps, 'artworkEnabled'))) return disabledFailure('artworkEnabled');
      const game = await deps.resolveGame(id);
      if (!game.ok) return game;
      const g = { id: game.id, name: game.name };
      return routeServerFirst(deps, 'artworkEnabled', () => deps.server.fetchArt(g), () => localFetchArt(g));
    },

    getSteamGridKeyStatus: async () => (local() ? keyStatus(await deps.local.getKeyStatus('steamgriddb')) : deps.server.getSteamGridKeyStatus()),
    setSteamGridKey: async (key) => {
      if (!local()) return deps.server.setSteamGridKey(key);
      const r = await deps.local.setKey('steamgriddb', key);
      return r.ok ? { ok: true, set: true } : toServerFailure(r);
    },
    clearSteamGridKey: async () => {
      if (!local()) return deps.server.clearSteamGridKey();
      const r = await deps.local.clearKey('steamgriddb');
      return r.ok ? { ok: true, set: false } : toServerFailure(r);
    },

    checkForUpdates(opts) {
      const force = !!opts && typeof opts === 'object' && (opts as { force?: unknown }).force === true;
      return updateCheck({ trigger: 'manual', ...(force ? { force: true } : {}) });
    },

    async autoCheckForUpdates() {
      if (!(await flagOn(deps, 'updateCheckEnabled'))) return disabledFailure('updateCheckEnabled');
      return updateCheck({ trigger: 'auto' });
    },
  };
}
