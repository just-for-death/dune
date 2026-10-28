/**
 * Pure helpers for the "Where it runs" settings screens (DUN-032): local
 * sources, remote servers and API keys on the Dune server.
 *
 * The IPC handlers resolve to ServerResult (@dune/shared): `{ ok: true, ...body }`
 * or `{ ok: false, status?, code, message }`. The HTTP status and code are
 * structured, so failures are classified from them, never from message text.
 */
import type { ServerFailure } from '@dune/shared';
import { checkServerUrl } from './serverUrl';
import { defaultTranslator, type Locale, type Translator } from '../i18n';

export type ServerErrorKind = 'forbidden' | 'unauthorized' | 'bad-request' | 'not-found' | 'unreachable' | 'no-server' | 'other';

/** What is known about a failed call: a ServerFailure, or a thrown IPC error (message only). */
export type FailureInfo = Partial<Pick<ServerFailure, 'status' | 'code' | 'message'>>;

/** True for an `{ ok: true }` ServerResult. */
export function isServerOk(result: unknown): boolean {
  return !(result instanceof Error) && !!result && typeof result === 'object' && (result as { ok?: unknown }).ok === true;
}

export function classifyServerError(failure: FailureInfo | undefined): ServerErrorKind {
  if (!failure) return 'other';
  const { status, code } = failure;
  if (code === 'NO_SERVER') return 'no-server';
  if (code === 'NETWORK' && status === undefined) return 'unreachable';
  if (status === 403) return 'forbidden';
  if (status === 401) return 'unauthorized';
  if (status === 400) return 'bad-request';
  if (status === 404) return 'not-found';
  return 'other';
}

// English forms, for callers without a translator; the UI uses t() with the same keys.
export const NEEDS_ADMIN = defaultTranslator('where.needsAdmin');
export const NO_SERVER = defaultTranslator('where.noServer');
export const NOT_AVAILABLE_YET = defaultTranslator('where.notAvailableYet');
export const NOT_TESTED = defaultTranslator('where.notTested');
export const PROVIDER_PENDING = defaultTranslator('where.providerPending');

export type Action = 'load' | 'add-source' | 'remove-source' | 'add-server' | 'remove-server' | 'issue-key' | 'revoke-key';

/** Admin-only on the server (requireAdmin in packages/server/src/server.ts). */
const ADMIN_ACTIONS: ReadonlySet<Action> = new Set(['add-source', 'remove-source', 'add-server', 'remove-server']);

/**
 * One short, user-facing sentence for a failed call. Never includes request
 * data (paths, URLs or keys), only what went wrong.
 */
export function describeFailure(action: Action, failure: FailureInfo | undefined, t: Translator = defaultTranslator): string {
  const kind = classifyServerError(failure);
  // authMiddleware also answers 403 for an unknown key, so on non-admin
  // actions a 403 means this PC's key was rejected.
  if (kind === 'forbidden') return t(ADMIN_ACTIONS.has(action) ? 'where.needsAdmin' : 'where.fail.keyRejected');
  if (kind === 'unauthorized') return t('where.fail.noKey');
  if (kind === 'unreachable') return t('where.fail.unreachable');
  if (kind === 'no-server') return t('where.noServerSentence');
  if (kind === 'not-found') {
    if (action === 'remove-source') return t('where.fail.sourceGone');
    if (action === 'remove-server') return t('where.fail.serverGone');
    if (action === 'revoke-key') return t('where.fail.keyGone');
    return t('where.fail.unsupported');
  }
  if (kind === 'bad-request') {
    if (action === 'add-source') return t('where.fail.badPath');
    if (action === 'add-server') return t('where.fail.badAddress');
  }
  switch (action) {
    case 'load': return t('where.fail.load');
    case 'add-source': return t('where.fail.addSource');
    case 'remove-source': return t('where.fail.removeSource');
    case 'add-server': return t('where.fail.addServer');
    case 'remove-server': return t('where.fail.removeServer');
    case 'issue-key': return t('where.fail.issueKey');
    case 'revoke-key': return t('where.fail.revokeKey');
  }
}

/** The failure details of a thrown IPC error or an `{ ok: false }` reply. */
export function failureInfo(result: unknown): FailureInfo | undefined {
  if (result instanceof Error) return { message: result.message };
  if (!result || typeof result !== 'object' || (result as { ok?: unknown }).ok !== false) return undefined;
  const r = result as { status?: unknown; code?: unknown; message?: unknown };
  return {
    ...(typeof r.status === 'number' ? { status: r.status } : {}),
    ...(typeof r.code === 'string' ? { code: r.code } : {}),
    ...(typeof r.message === 'string' ? { message: r.message } : {}),
  };
}

export type Check = { ok: true; value: string } | { ok: false; error: string };

/**
 * Server-side folder path for a local source. The renderer cannot see the
 * server's disk, so only the shape is checked: absolute POSIX or Windows path.
 */
export function validateSourcePath(input: string, existing: readonly string[] = [], t: Translator = defaultTranslator): Check {
  const value = input.trim();
  if (!value) return { ok: false, error: t('where.check.pathEmpty') };
  if (value.includes('\0')) return { ok: false, error: t('where.check.pathInvalidChar') };
  const absolute = value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
  if (!absolute) return { ok: false, error: t('where.check.pathNotAbsolute') };
  const normalized = stripTrailingSeparators(value);
  if (existing.some(p => stripTrailingSeparators(p) === normalized)) return { ok: false, error: t('where.check.sourceDuplicate') };
  return { ok: true, value: normalized };
}

function stripTrailingSeparators(path: string): string {
  if (path === '/' || /^[A-Za-z]:[\\/]$/.test(path)) return path;
  return path.replace(/[\\/]+$/, '') || path;
}

/** Address of another Dune server to replicate to. Same rules as this PC's server address. */
export function validateRemoteServerUrl(input: string, existing: readonly string[] = [], t: Translator = defaultTranslator): Check {
  if (!input.trim()) return { ok: false, error: t('where.check.serverEmpty') };
  const result = checkServerUrl(input, t);
  if (!result.ok) return { ok: false, error: result.error };
  const known = existing.map(url => {
    const check = checkServerUrl(url, t);
    return check.ok ? check.url : url;
  });
  if (known.includes(result.url)) return { ok: false, error: t('where.check.serverDuplicate') };
  return { ok: true, value: result.url };
}

export const KEY_NAME_MAX = 60;

/** Optional label for a newly issued key. */
export function validateKeyName(input: string, t: Translator = defaultTranslator): Check {
  const value = input.trim().replace(/\s+/g, ' ');
  if (value.length > KEY_NAME_MAX) return { ok: false, error: t('where.check.keyNameTooLong', { max: KEY_NAME_MAX }) };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, error: t('where.check.keyNameInvalidChar') };
  return { ok: true, value };
}

/** "Set" / "Not set" for this PC's key. The key value itself is never shown. */
export function keyStatus(key: string | null | undefined): 'Set' | 'Not set' {
  return typeof key === 'string' && key.trim() !== '' ? 'Set' : 'Not set';
}

/** Key creation date; without a locale the system's is used (as before DUN-044). */
export function formatCreated(iso: string, t: Translator = defaultTranslator, locale?: Locale): string {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return t('where.unknownDate');
  return date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** English-only count ("2 sources"); the UI uses tc() with where.*.count keys. */
export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
