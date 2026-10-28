import type { ProviderKeyStatusResult, ServerFailure, ServerResult } from '@dune/shared';
import { ServerCallError, UNKNOWN_SERVER_CODE, toServerFailure } from './serverError';
import { invalidArgument, seg, type ServerClient, type ServerRequest } from './serverClient';

/**
 * IPC handlers that only forward one call to the Dune Server (DUN-068/072/121).
 * Every renderer argument is checked here before it reaches a URL; ids and
 * limits must be numbers (or the server's key-id format) and every path
 * segment is encoded by `seg()`. Each handler resolves to a ServerResult and
 * passes the server's status/code/message through unchanged.
 */

type Handler = (_event: unknown, ...args: unknown[]) => Promise<ServerResult<object>>;

/** Throws INVALID_ARGUMENT unless `v` is a non-empty string of at most `max` chars. */
export function requireString(v: unknown, name: string, max = 500): string {
  if (typeof v !== 'string' || v.trim() === '' || v.length > max) throw new ServerCallError(invalidArgument(`Invalid ${name}`));
  return v;
}

function optionalString(v: unknown, name: string, max = 500): string | undefined {
  return v === undefined || v === null || v === '' ? undefined : requireString(v, name, max);
}

/** A positive safe integer id (local sources, remote servers). */
export function requireId(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new ServerCallError(invalidArgument('Invalid id'));
  return v;
}

/** Optional list limit: an integer 1..100, or undefined for the server default. */
export function optionalLimit(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 100) throw new ServerCallError(invalidArgument('Invalid limit'));
  return v;
}

/** Server API key ids are the first 12 hex chars of the key hash (server.ts DELETE /api/api-keys/:id). */
export const API_KEY_ID = /^[0-9a-f]{12}$/;

function oneOf<T extends string>(v: unknown, allowed: readonly T[], name: string, fallback?: T): T {
  if ((v === undefined || v === null) && fallback !== undefined) return fallback;
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  throw new ServerCallError(invalidArgument(`Invalid ${name}`));
}

const GRAPH_RANGES = ['all', 'year', 'month', 'week', 'custom'] as const;
const COMPARE_RANGES = ['week', 'month', 'year'] as const;
const RESOLUTIONS = ['local', 'remote', 'both', 'later'] as const;

function customRange(v: unknown): { start?: string; end?: string } {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object') throw new ServerCallError(invalidArgument('Invalid custom range'));
  const r = v as Record<string, unknown>;
  return { start: optionalString(r.start, 'range start', 40), end: optionalString(r.end, 'range end', 40) };
}

function plainObject(v: unknown, name: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ServerCallError(invalidArgument(`Invalid ${name}`));
  return v as Record<string, unknown>;
}

export interface ServerIpcOptions {
  /** settings.artworkEnabled; art routes answer PROVIDER_DISABLED until it is on. */
  artworkEnabled: () => boolean;
}

const USER_ROLES = ['admin', 'member'] as const;
type CurrentUser = { id: string; name: string; role: (typeof USER_ROLES)[number] };

const PROVIDER_DISABLED = { ok: false as const, code: 'PROVIDER_DISABLED', message: 'Artwork lookups are turned off in Settings.' };

const PROVIDER_FLAGS = ['hltbEnabled', 'artworkEnabled'] as const;
type ProviderFlags = { [K in (typeof PROVIDER_FLAGS)[number]]: boolean };

/** A provider-flag patch: a plain object with one or both flags, booleans only, nothing else. */
function providerFlagPatch(v: unknown): Partial<ProviderFlags> {
  const p = plainObject(v, 'provider flags');
  const keys = Object.keys(p);
  if (keys.length === 0) throw new ServerCallError(invalidArgument('No provider flags to change'));
  const patch: Partial<ProviderFlags> = {};
  for (const key of keys) {
    if (!(PROVIDER_FLAGS as readonly string[]).includes(key)) throw new ServerCallError(invalidArgument(`Unknown provider flag: ${key.slice(0, 40)}`));
    const value = p[key];
    if (typeof value !== 'boolean') throw new ServerCallError(invalidArgument(`${key} must be true or false`));
    patch[key as keyof ProviderFlags] = value;
  }
  return patch;
}

export function createServerIpcHandlers(client: ServerClient, opts: ServerIpcOptions): Record<string, Handler> {
  // Build the request from the arguments (may throw INVALID_ARGUMENT), then call.
  const art = (handler: Handler): Handler => async (event, ...args) => (opts.artworkEnabled() ? handler(event, ...args) : PROVIDER_DISABLED);
  const h = (build: (...args: unknown[]) => ServerRequest): Handler => async (_event, ...args) => {
    let req: ServerRequest;
    try {
      req = build(...args);
    } catch (err) {
      return toServerFailure(err);
    }
    return client.call(req);
  };

  /** DUN-092: provider-key routes answer exactly `{ set }`; never spread the body. */
  const keyStatus = (req: () => ServerRequest) => async (): Promise<ProviderKeyStatusResult> => {
    let built: ServerRequest;
    try {
      built = req();
    } catch (err) {
      return toServerFailure(err);
    }
    const res = await client.call<{ set?: unknown }>(built);
    return res.ok ? { ok: true, set: res.set === true } : (res as ServerFailure);
  };

  /**
   * DUN-115: GET /api/users/me answers `{ success, user: { id, name, role } }`.
   * Resolves to exactly `{ ok, id, name, role }`; a missing user or a role other
   * than admin/member is a failure, never passed on. 401/403 pass through.
   */
  const currentUser = async (): Promise<ServerResult<CurrentUser>> => {
    const res = await client.call<{ user?: unknown }>({ method: 'GET', path: '/api/users/me' });
    if (!res.ok) return res as ServerFailure;
    const u = res.user && typeof res.user === 'object' ? (res.user as Record<string, unknown>) : null;
    if (!u || typeof u.id !== 'string' || typeof u.name !== 'string'
      || typeof u.role !== 'string' || !(USER_ROLES as readonly string[]).includes(u.role)) {
      return { ok: false, code: UNKNOWN_SERVER_CODE, message: 'The Dune Server sent an invalid user record.' };
    }
    return { ok: true, id: u.id, name: u.name, role: u.role as CurrentUser['role'] };
  };

  /**
   * Server provider flags: GET /api/settings answers `{ success, settings: {...} }`.
   * Resolves to exactly `{ ok, hltbEnabled, artworkEnabled }`; no other settings
   * field is passed on. A missing or non-boolean flag is a failure.
   */
  const readProviderFlags = async (): Promise<ServerResult<ProviderFlags>> => {
    const res = await client.call<{ settings?: unknown }>({ method: 'GET', path: '/api/settings' });
    if (!res.ok) return res as ServerFailure;
    const s = res.settings && typeof res.settings === 'object' ? (res.settings as Record<string, unknown>) : null;
    if (!s || typeof s.hltbEnabled !== 'boolean' || typeof s.artworkEnabled !== 'boolean') {
      return { ok: false, code: UNKNOWN_SERVER_CODE, message: 'The Dune Server sent invalid settings.' };
    }
    return { ok: true, hltbEnabled: s.hltbEnabled, artworkEnabled: s.artworkEnabled };
  };

  /**
   * POST /api/settings (admin only) with just the validated flags. The server
   * answers `{ success: true }` only, so the saved flags are read back with a GET.
   * 403 FORBIDDEN / PROVIDER_DISABLED / INVALID_SETTINGS pass through.
   */
  const writeProviderFlags = async (_event: unknown, patch: unknown): Promise<ServerResult<ProviderFlags>> => {
    let body: Partial<ProviderFlags>;
    try {
      body = providerFlagPatch(patch);
    } catch (err) {
      return toServerFailure(err);
    }
    const res = await client.call({ method: 'POST', path: '/api/settings', body });
    if (!res.ok) return res as ServerFailure;
    return readProviderFlags();
  };

  return {
    // Playtime
    'playtime:summary': h((game) => ({ method: 'GET', path: '/api/playtime', query: { game: optionalString(game, 'game') } })),
    'playtime:recent': h((limit) => ({ method: 'GET', path: '/api/playtime/recent', query: { limit: optionalLimit(limit) } })),
    'playtime:total': h(() => ({ method: 'GET', path: '/api/playtime/total' })),
    'playtime:graph': h((range, custom) => ({
      method: 'GET', path: '/api/playtime/graph',
      query: { range: oneOf(range, GRAPH_RANGES, 'range', 'all'), ...customRange(custom) },
    })),
    'playtime:comparison': h((range) => ({
      method: 'GET', path: '/api/playtime/comparison', query: { range: oneOf(range, COMPARE_RANGES, 'range', 'week') },
    })),
    'playtime:export': h((format, range, custom) => ({
      method: 'GET', path: '/api/playtime/export',
      query: { format: oneOf(format, ['csv', 'json'] as const, 'format', 'json'), range: oneOf(range, GRAPH_RANGES, 'range', 'all'), ...customRange(custom) },
    })),

    // Achievements
    'achievements:detail': h((game) => ({ method: 'GET', path: `/api/achievements/detail/${seg(requireString(game, 'game'))}` })),
    'achievements:summary': h((game) => ({ method: 'GET', path: '/api/achievements', query: { game: optionalString(game, 'game') } })),
    'achievements:recent': h((limit) => ({ method: 'GET', path: '/api/achievements/recent', query: { limit: optionalLimit(limit) } })),

    // HLTB
    'hltb:get': h((name) => ({ method: 'GET', path: `/api/hltb/${seg(requireString(name, 'game'))}` })),

    // Save versions
    // Saves are keyed by game id on the server (DUN-038); no name form.
    'saves:listVersions': h((gameId) => ({ method: 'GET', path: '/api/save-versions', query: { gameId: requireId(gameId) } })),
    'saves:restore': h((gameId, versionId) => ({
      method: 'POST', path: '/api/restore-version',
      body: { gameId: requireId(gameId), versionId: requireString(versionId, 'version id', 200) },
    })),

    // Conflicts
    'conflicts:list': h((game) => ({ method: 'GET', path: '/api/conflicts', query: { game: optionalString(game, 'game') } })),
    'conflicts:resolve': h((id, resolution) => ({
      method: 'POST', path: `/api/conflicts/${seg(requireString(id, 'conflict id', 200))}/resolve`,
      body: { resolution: oneOf(resolution, RESOLUTIONS, 'resolution') },
    })),

    // Backup profiles / storage
    'backupProfile:get': h((game) => ({ method: 'GET', path: '/api/backup-profile', query: { game: requireString(game, 'game') } })),
    'backupProfile:set': h((profile) => ({ method: 'POST', path: '/api/backup-profile', body: plainObject(profile, 'backup profile') })),
    'storage:get': h((game) => ({ method: 'GET', path: '/api/storage', query: { game: requireString(game, 'game') } })),

    // AI analysis
    'ai:analyze': h((payload) => {
      const p = plainObject(payload, 'analysis request');
      if (!Array.isArray(p.files)) throw new ServerCallError(invalidArgument('Invalid files'));
      return { method: 'POST', path: '/api/analyze-files-ai', body: { gameName: requireString(p.gameName, 'game'), files: p.files } };
    }),

    // SteamGridDB art (the key lives on the server only; DUN-092)
    'art:search': art(h((query) => ({ method: 'GET', path: '/api/search-art', query: { query: requireString(query, 'query') } }))),
    // DUN-113: auto-match changes thumbnails on the server, so it is a POST (no body).
    'art:auto-match': art(h(() => ({ method: 'POST', path: '/api/auto-match-all' }))),
    'steamGridKey:status': keyStatus(() => ({ method: 'GET', path: '/api/provider-keys/steamgriddb' })),
    'steamGridKey:set': async (_event, key) => keyStatus(() => ({
      method: 'PUT', path: '/api/provider-keys/steamgriddb', body: { key: requireString(key, 'key', 500).trim() },
    }))(),
    'steamGridKey:clear': keyStatus(() => ({ method: 'DELETE', path: '/api/provider-keys/steamgriddb' })),

    // Local sync / sources
    'local-sync:trigger': h(() => ({ method: 'POST', path: '/api/local-sync', body: {} })),
    'local-sources:get': h(() => ({ method: 'GET', path: '/api/local-sources' })),
    'local-sources:add': h((sourcePath) => ({ method: 'POST', path: '/api/local-sources', body: { path: requireString(sourcePath, 'path', 4096) } })),
    'local-sources:remove': h((id) => ({ method: 'DELETE', path: `/api/local-sources/${seg(requireId(id))}` })),

    // Remote servers
    'remote-servers:get': h(() => ({ method: 'GET', path: '/api/remote-servers' })),
    'remote-servers:add': h((url) => ({ method: 'POST', path: '/api/remote-servers', body: { url: requireString(url, 'url', 2000) } })),
    'remote-servers:remove': h((id) => ({ method: 'DELETE', path: `/api/remote-servers/${seg(requireId(id))}` })),

    // API keys (self-service)
    'api-keys:get': h(() => ({ method: 'GET', path: '/api/api-keys' })),
    'api-keys:add': h((payload) => {
      const p = payload === undefined || payload === null ? {} : plainObject(payload, 'request');
      return { method: 'POST', path: '/api/api-keys', body: { description: optionalString(p.description, 'description', 200) } };
    }),
    'api-keys:remove': h((id) => {
      if (typeof id !== 'string' || !API_KEY_ID.test(id)) throw new ServerCallError(invalidArgument('Invalid key id'));
      return { method: 'DELETE', path: `/api/api-keys/${seg(id)}` };
    }),

    // Current user (DUN-115: renderer role gating)
    'users:me': currentUser,

    // Server provider flags (admin writes; only hltbEnabled/artworkEnabled cross IPC)
    'settings:providerFlags:get': readProviderFlags,
    'settings:providerFlags:set': writeProviderFlags,

    // Ollama
    // DUN-095/057: the server uses only its stored Ollama endpoint (admin-only);
    // no endpoint ever comes from the renderer. OLLAMA_NOT_CONFIGURED / 403 pass through.
    'ollama:models': h(() => ({ method: 'GET', path: '/api/ollama-models' })),
    'ollama:health': h(() => ({ method: 'GET', path: '/api/ollama-health' })),
  };
}
