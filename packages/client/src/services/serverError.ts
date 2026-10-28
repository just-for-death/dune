/**
 * Plain wording for a failed server call (Dune UI contract, ServerFailure in
 * @dune/shared). Never shows the raw `code` or HTTP status.
 */
import type { CloudSyncResult, ServerFailure } from '@dune/shared';
import { defaultPluralTranslator, defaultTranslator, type PluralTranslator, type Translator } from '../i18n';

export const NETWORK_MESSAGE = defaultTranslator('serverError.network');
export const NO_SERVER_MESSAGE = defaultTranslator('serverError.noServer');
export const UNAUTHORIZED_MESSAGE = defaultTranslator('serverError.unauthorized');
export const FORBIDDEN_MESSAGE = defaultTranslator('serverError.forbidden');
export const GENERIC_SERVER_MESSAGE = defaultTranslator('serverError.generic');

export function serverFailureMessage(f: ServerFailure, t: Translator = defaultTranslator): string {
  if (f.code === 'NO_SERVER') return t('serverError.noServer');
  if (f.code === 'NETWORK' && f.status === undefined) return t('serverError.network');
  if (f.status === 401) return t('serverError.unauthorized');
  if (f.status === 403) return t('serverError.forbidden');
  // Any other message comes from the server as written (not translated here).
  const message = typeof f.message === 'string' ? f.message.trim() : '';
  return message || t('serverError.generic');
}

type CloudSyncFailure = Extract<CloudSyncResult, { ok: false }>;

/**
 * Short summary for a failed save sync / restore. With per-item failures it
 * only gives the count; otherwise the plain failure wording.
 */
export function cloudSyncFailureMessage(
  f: CloudSyncFailure,
  action: 'sync' | 'restore',
  t: Translator = defaultTranslator,
  tc: PluralTranslator = defaultPluralTranslator,
): string {
  const count = f.failures?.length ?? 0;
  if (count > 0) return tc(action === 'sync' ? 'serverError.syncProblems' : 'serverError.restoreProblems', count);
  return serverFailureMessage(f, t);
}
