import type { ElectronAPI, ManifestSuggestion } from '@dune/shared';
import type { MessageKey } from '../../i18n';

/**
 * Pure helpers for the save-path suggestions UI (SavePathSuggestions.tsx).
 * Paths are plain text: never parsed as HTML or turned into links. The
 * PCGamingWiki page is linked only when it is an https:// URL.
 */

export type ManifestApi = Pick<ElectronAPI, 'getManifestSuggestions'>;

/** True when the bridge has a callable getManifestSuggestions (the preload may not expose it yet). */
export function hasManifestApi(api: Partial<ManifestApi> | undefined | null): api is ManifestApi {
  return !!api && typeof api.getManifestSuggestions === 'function';
}

/** The URL (normalised by `new URL`) when it parses and its protocol is exactly https:, else null. */
export function safePageUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url === '') return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

export type ManifestOutcome =
  | { kind: 'result'; suggestions: ManifestSuggestion[]; attribution: string; pageUrl: string | null; stale: boolean }
  | { kind: 'error'; code: string };

/**
 * A getManifestSuggestions reply (or a throw) as something the view can show.
 * Drops malformed entries and exact duplicates; `pageUrl` is already https-checked.
 * A reply that is not a ServerResult at all is an error.
 */
export function normalizeManifestResult(result: unknown): ManifestOutcome {
  if (result instanceof Error || !result || typeof result !== 'object') return { kind: 'error', code: 'UNKNOWN' };
  const r = result as { ok?: unknown; code?: unknown; suggestions?: unknown; attribution?: unknown; pageUrl?: unknown; stale?: unknown };
  if (r.ok !== true) return { kind: 'error', code: typeof r.code === 'string' && r.code !== '' ? r.code : 'UNKNOWN' };
  if (!Array.isArray(r.suggestions)) return { kind: 'error', code: 'UNKNOWN' };
  const seen = new Set<string>();
  const suggestions: ManifestSuggestion[] = [];
  for (const item of r.suggestions as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Partial<Record<keyof ManifestSuggestion, unknown>>;
    if (typeof s.path !== 'string' || s.path.trim() === '') continue;
    if (s.kind !== 'save' && s.kind !== 'config') continue;
    const id = `${s.kind}\u0000${s.path}`;
    if (seen.has(id)) continue;
    seen.add(id);
    suggestions.push({ path: s.path, kind: s.kind, exists: s.exists === true });
  }
  return {
    kind: 'result',
    suggestions,
    attribution: typeof r.attribution === 'string' ? r.attribution.trim() : '',
    pageUrl: safePageUrl(r.pageUrl),
    stale: r.stale === true,
  };
}

/**
 * One lookup, only ever started by a click. Never rejects: a missing bridge
 * is 'UNAVAILABLE', a throw is 'NETWORK'.
 */
export async function runManifestLookup(api: Partial<ManifestApi> | undefined | null, gameId: string): Promise<ManifestOutcome> {
  if (!hasManifestApi(api)) return { kind: 'error', code: 'UNAVAILABLE' };
  try {
    return normalizeManifestResult(await api.getManifestSuggestions(gameId));
  } catch {
    return { kind: 'error', code: 'NETWORK' };
  }
}

/** Codes where trying again later can help: no response, provider down/slow, or manifest temporarily unavailable (503). */
const RETRY_CODES = new Set(['NETWORK', 'UNREACHABLE', 'PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'MANIFEST_UNAVAILABLE']);
const NOT_FOUND_CODES = new Set(['GAME_NOT_FOUND', 'MANIFEST_NOT_FOUND']);

export type ManifestErrorKind = 'unavailable' | 'disabled' | 'notFound' | 'retry' | 'generic';

/** Which message a failure code gets (INVALID_GAME_ID and unknown codes are generic). */
export function manifestErrorKind(code: string): ManifestErrorKind {
  if (code === 'UNAVAILABLE') return 'unavailable';
  if (code === 'PROVIDER_DISABLED') return 'disabled';
  if (NOT_FOUND_CODES.has(code)) return 'notFound';
  if (RETRY_CODES.has(code)) return 'retry';
  return 'generic';
}

const ERROR_KEYS: Record<ManifestErrorKind, MessageKey> = {
  unavailable: 'manifest.unavailable',
  disabled: 'manifest.errorDisabled',
  notFound: 'manifest.errorNotFound',
  retry: 'manifest.errorNetwork',
  generic: 'manifest.errorGeneric',
};

/** i18n key for a failed lookup. */
export function manifestErrorKey(code: string): MessageKey {
  return ERROR_KEYS[manifestErrorKind(code)];
}

/** True when the failure offers a Try again button (network / unavailable). */
export function isRetryable(code: string): boolean {
  return manifestErrorKind(code) === 'retry';
}

/** Trailing / or \ removed (a bare root such as "/" or "C:\" is kept). */
function trimSeparators(path: string): string {
  const trimmed = path.trim();
  const stripped = trimmed.replace(/[\\/]+$/, '');
  return stripped === '' || /^[A-Za-z]:$/.test(stripped) ? trimmed : stripped;
}

/** True when `path` is the game's current save path (ignoring surrounding spaces and trailing separators). */
export function isSamePath(path: string, current: string | null | undefined): boolean {
  if (typeof current !== 'string' || current.trim() === '') return false;
  return trimSeparators(path) === trimSeparators(current);
}
