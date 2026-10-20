/**
 * Plain wording for a failed server call (Dune UI contract, ServerFailure in
 * @dune/shared). Never shows the raw `code` or HTTP status.
 */
import type { CloudSyncResult, ServerFailure } from '@dune/shared';

export const NETWORK_MESSAGE = "Can't reach the Dune server. Check the address and that it's running.";
export const NO_SERVER_MESSAGE = 'Connect a Dune server first.';
export const UNAUTHORIZED_MESSAGE = "The server didn't accept this PC's key.";
export const FORBIDDEN_MESSAGE = 'This needs an admin key.';
export const GENERIC_SERVER_MESSAGE = 'The server returned an error.';

export function serverFailureMessage(f: ServerFailure): string {
  if (f.code === 'NO_SERVER') return NO_SERVER_MESSAGE;
  if (f.code === 'NETWORK' && f.status === undefined) return NETWORK_MESSAGE;
  if (f.status === 401) return UNAUTHORIZED_MESSAGE;
  if (f.status === 403) return FORBIDDEN_MESSAGE;
  const message = typeof f.message === 'string' ? f.message.trim() : '';
  return message || GENERIC_SERVER_MESSAGE;
}

type CloudSyncFailure = Extract<CloudSyncResult, { ok: false }>;

/**
 * Short summary for a failed save sync / restore. With per-item failures it
 * only gives the count; otherwise the plain failure wording.
 */
export function cloudSyncFailureMessage(f: CloudSyncFailure, verb: 'Sync' | 'Restore'): string {
  const count = f.failures?.length ?? 0;
  if (count > 0) return `${verb} finished with ${count} problem${count === 1 ? '' : 's'}`;
  return serverFailureMessage(f);
}
