/**
 * getManifestSuggestions (pure logic, no Electron import). Rules (PL, 2026-10-28):
 * - Server configured: GET /api/saves (the server's id for this game, matched by name), then
 *   GET /api/manifest/:serverGameId. The SERVER flag decides; its answers (400, 401, 403
 *   PROVIDER_DISABLED, 404 GAME_NOT_FOUND / MANIFEST_NOT_FOUND, 503 MANIFEST_UNAVAILABLE)
 *   pass through unchanged. Only an unreachable server (isServerUnreachable) falls back to local.
 * - No server, or unreachable: the local @dune/providers manifest provider, gated on the local
 *   Settings.manifestEnabled (off -> PROVIDER_DISABLED before any store, cache or network I/O).
 * - Main expands the entry on this machine (./expand.ts) and returns it. Nothing is applied or written.
 */
import type { ElectronAPI, Game, ServerFailure, ServerResult } from '@dune/shared';
import { MANIFEST_ATTRIBUTION, ManifestGameSchema, type ManifestGame, type ManifestMatch, type ManifestQuery, type ProviderResult } from '@dune/providers';
import { isServerUnreachable } from '../providers/routing';
import type { MaybePromise } from '../providers/types';
import { seg, type ServerClient } from '../net/serverClient';
import { normalizeStoreId } from '../scanner/storeIds';
import { expandManifestFiles, type ExpandContext } from './expand';

export type ManifestSuggestionsResult = Awaited<ReturnType<ElectronAPI['getManifestSuggestions']>>;

export const MANIFEST_DISABLED_MESSAGE = 'Save-path suggestions are turned off in Settings.';
const MAX_ATTRIBUTION_CHARS = 500;

export interface ManifestSuggestionsDeps {
  client: Pick<ServerClient, 'baseUrl' | 'call'>;
  /** Local Settings.manifestEnabled (only `true` enables). */
  localEnabled(): MaybePromise<boolean>;
  /** Local @dune/providers manifest lookup (created lazily by main). */
  localLookup(query: ManifestQuery): Promise<ProviderResult<ManifestMatch>>;
  findGame(id: number): MaybePromise<Game | null>;
  expandContext(game: Game): MaybePromise<ExpandContext>;
}

const fail = (code: string, message: string, status?: number): ServerFailure =>
  status === undefined ? { ok: false, code, message } : { ok: false, status, code, message };

/** IPC game ids are positive integers; a digit string ("12") or a number. */
export function parseIpcGameId(raw: unknown): number | null {
  const n = typeof raw === 'string' && /^[1-9][0-9]{0,15}$/.test(raw) ? Number(raw) : raw;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Only a PCGamingWiki https article link is passed to the renderer. */
export function safePageUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname === 'www.pcgamingwiki.com' && !u.username && !u.password && !u.port && u.pathname.startsWith('/wiki/') ? u.toString() : null;
  } catch {
    return null;
  }
}

function attributionText(raw: unknown): string {
  const text = raw && typeof raw === 'object' ? (raw as { text?: unknown }).text : raw;
  return typeof text === 'string' && text.trim() && text.length <= MAX_ATTRIBUTION_CHARS ? text : MANIFEST_ATTRIBUTION.text;
}

const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** The server's id for this game: exact name, then ASCII case-insensitive (server NOCASE). */
export function findServerGameId(games: unknown, name: string): number | null {
  if (!Array.isArray(games)) return null;
  const rows = games.filter((g): g is { id: number; name: string } => !!g && typeof g === 'object' && typeof (g as { name?: unknown }).name === 'string' && parseIpcGameId((g as { id?: unknown }).id) !== null);
  const hit = rows.find((g) => g.name === name) ?? rows.find((g) => asciiLower(g.name) === asciiLower(name));
  return hit ? hit.id : null;
}

type Entry = { files: ManifestGame['files']; attribution: string; pageUrl: string | null; stale: boolean };
type Step = { kind: 'entry'; entry: Entry } | { kind: 'fail'; failure: ServerFailure } | { kind: 'unreachable' };

async function fromServer(deps: ManifestSuggestionsDeps, game: Game): Promise<Step> {
  const list = await deps.client.call<{ games?: unknown }>({ method: 'GET', path: '/api/saves' });
  if (isServerUnreachable(list)) return { kind: 'unreachable' };
  if (!list.ok) return { kind: 'fail', failure: list };
  const serverId = findServerGameId(list.games, game.name);
  if (serverId === null) return { kind: 'fail', failure: fail('GAME_NOT_FOUND', 'This game is not on your Dune Server yet. Sync it first.', 404) };
  const res: ServerResult<{ entry?: unknown; pageUrl?: unknown; attribution?: unknown; stale?: unknown }> =
    await deps.client.call({ method: 'GET', path: `/api/manifest/${seg(serverId)}` });
  if (isServerUnreachable(res)) return { kind: 'unreachable' };
  if (!res.ok) return { kind: 'fail', failure: res };
  const parsed = ManifestGameSchema.safeParse(res.entry);
  if (!parsed.success) return { kind: 'fail', failure: fail('MANIFEST_BAD_RESPONSE', 'The server sent an invalid manifest entry.') };
  return { kind: 'entry', entry: { files: parsed.data.files, attribution: attributionText(res.attribution), pageUrl: safePageUrl(res.pageUrl), stale: res.stale === true } };
}

export function manifestQueryFor(game: Pick<Game, 'name' | 'steamAppId' | 'gogId'>): ManifestQuery {
  const steam = normalizeStoreId(game.steamAppId);
  const gog = normalizeStoreId(game.gogId);
  return { title: game.name, ...(steam ? { steamId: Number(steam) } : {}), ...(gog ? { gogId: Number(gog) } : {}) };
}

async function fromLocal(deps: ManifestSuggestionsDeps, game: Game): Promise<Step> {
  let r: ProviderResult<ManifestMatch>;
  try {
    r = await deps.localLookup(manifestQueryFor(game));
  } catch {
    return { kind: 'fail', failure: fail('MANIFEST_UNAVAILABLE', 'The save-path manifest is unavailable right now.') };
  }
  if (r.ok) {
    const { game: entry, pageUrl, attribution } = r.value;
    return { kind: 'entry', entry: { files: entry.files, attribution: attributionText(attribution), pageUrl: safePageUrl(pageUrl), stale: r.stale === true } };
  }
  if (r.code === 'PROVIDER_DISABLED') return { kind: 'fail', failure: fail('PROVIDER_DISABLED', MANIFEST_DISABLED_MESSAGE) };
  if (r.code === 'PROVIDER_NOT_FOUND') return { kind: 'fail', failure: fail('MANIFEST_NOT_FOUND', 'This game is not in the save-path manifest.') };
  return { kind: 'fail', failure: fail('MANIFEST_UNAVAILABLE', 'The save-path manifest is unavailable right now.') };
}

async function enabled(deps: ManifestSuggestionsDeps): Promise<boolean> {
  try { return (await deps.localEnabled()) === true; } catch { return false; }
}

export function createManifestSuggestions(deps: ManifestSuggestionsDeps): (gameId: unknown) => Promise<ManifestSuggestionsResult> {
  return async (rawId) => {
    try {
      const id = parseIpcGameId(rawId);
      if (id === null) return fail('INVALID_GAME_ID', 'Invalid game id');
      const hasServer = deps.client.baseUrl() !== null;
      if (!hasServer && !(await enabled(deps))) return fail('PROVIDER_DISABLED', MANIFEST_DISABLED_MESSAGE);
      const game = await deps.findGame(id);
      if (!game) return fail('GAME_NOT_FOUND', 'Game not found');

      let step: Step = hasServer ? await fromServer(deps, game) : { kind: 'unreachable' };
      if (step.kind === 'unreachable') {
        step = (await enabled(deps)) ? await fromLocal(deps, game) : { kind: 'fail', failure: fail('PROVIDER_DISABLED', MANIFEST_DISABLED_MESSAGE) };
      }
      if (step.kind === 'fail') return step.failure;
      if (step.kind !== 'entry') return fail('MANIFEST_UNAVAILABLE', 'The save-path manifest is unavailable right now.');
      const suggestions = expandManifestFiles(step.entry.files, await deps.expandContext(game));
      return { ok: true, suggestions, attribution: step.entry.attribution, pageUrl: step.entry.pageUrl, ...(step.entry.stale ? { stale: true as const } : {}) };
    } catch {
      return fail('MANIFEST_UNAVAILABLE', 'The save-path manifest is unavailable right now.');
    }
  };
}
