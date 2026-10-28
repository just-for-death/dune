/**
 * Renderer wording for Dune Server URL checks (DUN-124).
 *
 * The rules live in @dune/shared (`checkServerUrl`, `normalizeServerUrl`),
 * shared with the main process; this file only turns a failed check's code
 * into the translated `serverUrl.<code>` message.
 */

import type { ServerUrlCheck, ServerUrlErrorCode } from '@dune/shared';
import type { MessageKey, Translator } from '../i18n';

export type ServerUrlFailure = Extract<ServerUrlCheck, { ok: false }>;

/** Every code the shared rules can return has a key (enforced by the Record type). */
const MESSAGE_KEYS: Record<ServerUrlErrorCode, MessageKey> = {
  empty: 'serverUrl.empty',
  scheme: 'serverUrl.scheme',
  needScheme: 'serverUrl.needScheme',
  needHost: 'serverUrl.needHost',
  credentials: 'serverUrl.credentials',
  query: 'serverUrl.query',
  invalid: 'serverUrl.invalid',
  port: 'serverUrl.port',
  incompleteHost: 'serverUrl.incompleteHost',
  fullIp: 'serverUrl.fullIp',
  blocked: 'serverUrl.blocked',
  portBlocked: 'serverUrl.portBlocked',
};

/** User-facing message for a rejected server URL. */
export function serverUrlMessage(t: Translator, failure: ServerUrlFailure): string {
  return t(MESSAGE_KEYS[failure.code], { example: t('serverUrl.example'), port: failure.port ?? '' });
}
