import type { ElectronAPI, UpdateInfo } from '@dune/shared';
import type { MessageKey } from '../../i18n';

/**
 * Pure helpers for the update-check UI (UpdateCheck.tsx). Release notes are
 * plain text and are never parsed as HTML or Markdown; the release page is
 * only ever linked when it is an https:// URL.
 */

export type UpdateCheckApi = Pick<ElectronAPI, 'checkForUpdates'>;

/** True when the bridge has a callable checkForUpdates (preload may not expose it yet). */
export function hasUpdateApi(api: Partial<UpdateCheckApi> | undefined): api is UpdateCheckApi {
  return !!api && typeof api.checkForUpdates === 'function';
}

/** The URL (normalised by `new URL`) when it parses and its protocol is exactly https:, else null. */
export function safeReleaseUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url === '') return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

export type UpdateOutcome =
  | { kind: 'result'; update: UpdateInfo; stale: boolean }
  | { kind: 'error'; code: string };

/** A checkForUpdates reply (or a throw) as something the view can show. Malformed replies are an error. */
export function outcomeFrom(result: unknown): UpdateOutcome {
  if (result instanceof Error || !result || typeof result !== 'object') return { kind: 'error', code: 'UNKNOWN' };
  const r = result as { ok?: unknown; code?: unknown; update?: unknown; stale?: unknown };
  if (r.ok !== true) return { kind: 'error', code: typeof r.code === 'string' ? r.code : 'UNKNOWN' };
  const u = r.update as Partial<UpdateInfo> | null | undefined;
  if (!u || typeof u !== 'object' || typeof u.version !== 'string' || typeof u.current !== 'string' || typeof u.isNewer !== 'boolean') {
    return { kind: 'error', code: 'UNKNOWN' };
  }
  const update: UpdateInfo = {
    version: u.version,
    current: u.current,
    releaseUrl: typeof u.releaseUrl === 'string' ? u.releaseUrl : '',
    notes: typeof u.notes === 'string' ? u.notes : '',
    isNewer: u.isNewer,
    ...(typeof u.publishedAt === 'string' ? { publishedAt: u.publishedAt } : {}),
  };
  return { kind: 'result', update, stale: r.stale === true };
}

/**
 * One manual check: always asks for a fresh answer (the click is the opt-in;
 * main may still fall back to its cache and say stale). Never rejects; a
 * missing bridge is 'UNAVAILABLE' and a throw is 'NETWORK'.
 */
export async function runUpdateCheck(api: Partial<UpdateCheckApi> | undefined): Promise<UpdateOutcome> {
  if (!hasUpdateApi(api)) return { kind: 'error', code: 'UNAVAILABLE' };
  try {
    return outcomeFrom(await api.checkForUpdates({ force: true }));
  } catch {
    return { kind: 'error', code: 'NETWORK' };
  }
}

/** Codes meaning the release server could not be reached (main: NETWORK; providers: timeout/unavailable). */
const NETWORK_CODES = new Set(['NETWORK', 'UNREACHABLE', 'PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE']);

/** i18n key for a failed check: unavailable bridge, disabled, network/unreachable, or generic. */
export function updateErrorKey(code: string): MessageKey {
  if (code === 'UNAVAILABLE') return 'updates.unavailable';
  if (code === 'PROVIDER_DISABLED') return 'updates.errorDisabled';
  if (NETWORK_CODES.has(code)) return 'updates.errorNetwork';
  return 'updates.errorGeneric';
}

/** The published date as a locale date (the user's time zone unless `timeZone` is given), or null if missing/invalid. */
export function formatPublished(iso: string | undefined, locale: string, timeZone?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', ...(timeZone ? { timeZone } : {}) }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}
