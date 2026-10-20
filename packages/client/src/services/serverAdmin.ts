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

export const NEEDS_ADMIN = 'Needs an admin key';
export const NO_SERVER = 'Connect a Dune server to manage this';
export const NOT_AVAILABLE_YET = 'Not available yet';
export const NOT_TESTED = 'Not tested';
export const PROVIDER_PENDING = 'Coming with provider settings';

export type Action = 'load' | 'add-source' | 'remove-source' | 'add-server' | 'remove-server' | 'issue-key' | 'revoke-key';

/** Admin-only on the server (requireAdmin in packages/server/src/server.ts). */
const ADMIN_ACTIONS: ReadonlySet<Action> = new Set(['add-source', 'remove-source', 'add-server', 'remove-server']);

/**
 * One short, user-facing sentence for a failed call. Never includes request
 * data (paths, URLs or keys), only what went wrong.
 */
export function describeFailure(action: Action, failure: FailureInfo | undefined): string {
  const kind = classifyServerError(failure);
  // authMiddleware also answers 403 for an unknown key, so on non-admin
  // actions a 403 means this PC's key was rejected.
  if (kind === 'forbidden') return ADMIN_ACTIONS.has(action) ? NEEDS_ADMIN : "The server rejected this PC's key.";
  if (kind === 'unauthorized') return "This PC has no server key. Set one in Dune server integration.";
  if (kind === 'unreachable') return 'Could not reach the Dune server.';
  if (kind === 'no-server') return `${NO_SERVER}.`;
  if (kind === 'not-found') {
    if (action === 'remove-source') return 'That source is already gone. Refresh the list.';
    if (action === 'remove-server') return 'That server is already gone. Refresh the list.';
    if (action === 'revoke-key') return 'That key is already revoked. Refresh the list.';
    return 'The server does not support this yet.';
  }
  if (kind === 'bad-request') {
    if (action === 'add-source') return 'The server could not use this path. Check that the folder exists on the server.';
    if (action === 'add-server') return 'The server rejected this address.';
  }
  switch (action) {
    case 'load': return 'Could not load this list.';
    case 'add-source': return 'Could not add the source.';
    case 'remove-source': return 'Could not remove the source.';
    case 'add-server': return 'Could not add the server.';
    case 'remove-server': return 'Could not remove the server.';
    case 'issue-key': return 'Could not issue a key.';
    case 'revoke-key': return 'Could not revoke the key.';
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
export function validateSourcePath(input: string, existing: readonly string[] = []): Check {
  const value = input.trim();
  if (!value) return { ok: false, error: 'Enter a folder path on the server.' };
  if (value.includes('\0')) return { ok: false, error: 'The path contains an invalid character.' };
  const absolute = value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
  if (!absolute) return { ok: false, error: 'Use a full path, e.g. /srv/games/saves.' };
  const normalized = stripTrailingSeparators(value);
  if (existing.some(p => stripTrailingSeparators(p) === normalized)) return { ok: false, error: 'This source is already listed.' };
  return { ok: true, value: normalized };
}

function stripTrailingSeparators(path: string): string {
  if (path === '/' || /^[A-Za-z]:[\\/]$/.test(path)) return path;
  return path.replace(/[\\/]+$/, '') || path;
}

/** Address of another Dune server to replicate to. Same rules as this PC's server address. */
export function validateRemoteServerUrl(input: string, existing: readonly string[] = []): Check {
  if (!input.trim()) return { ok: false, error: 'Enter the server address, e.g. http://192.168.1.20:3030.' };
  const result = checkServerUrl(input);
  if (!result.ok) return { ok: false, error: result.error };
  const known = existing.map(url => {
    const check = checkServerUrl(url);
    return check.ok ? check.url : url;
  });
  if (known.includes(result.url)) return { ok: false, error: 'This server is already listed.' };
  return { ok: true, value: result.url };
}

export const KEY_NAME_MAX = 60;

/** Optional label for a newly issued key. */
export function validateKeyName(input: string): Check {
  const value = input.trim().replace(/\s+/g, ' ');
  if (value.length > KEY_NAME_MAX) return { ok: false, error: `Use at most ${KEY_NAME_MAX} characters.` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, error: 'The name contains an invalid character.' };
  return { ok: true, value };
}

/** "Set" / "Not set" for this PC's key. The key value itself is never shown. */
export function keyStatus(key: string | null | undefined): 'Set' | 'Not set' {
  return typeof key === 'string' && key.trim() !== '' ? 'Set' : 'Not set';
}

export function formatCreated(iso: string): string {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return 'Unknown date';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
