/**
 * Renderer mirror of the main-process server URL rules (DUN-045).
 *
 * Source of truth: electron/sync/serverUrl.ts `normalizeServerUrl` (:33) plus
 * the SSRF/port policy of electron/utils.ts `validateServerUrl`. Those files
 * import Node modules (fs/path), so they cannot be bundled into the renderer;
 * the rules are mirrored here and the Desktop test table is replayed in
 * serverUrl.test.ts. Keep both in sync when Desktop changes the rules.
 */

import { defaultTranslator, type Translator } from '../i18n';

export type ServerUrlCheck = { ok: true; url: string } | { ok: false; error: string };

const ABSOLUTE_HTTP = /^(https?):\/\//i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

const BLOCKED_HOSTS = ['169.254.169.254', 'metadata.google.internal', '100.100.100.200', '169.254.169.253', 'instance-data'];
const BLOCKED_PORTS = [21, 22, 23, 25, 53, 69, 110, 119, 123, 143, 161, 194, 445];

/** Validate and normalise; the error text is user-facing. */
export function checkServerUrl(input: unknown, t: Translator = defaultTranslator): ServerUrlCheck {
  const fail = (error: string): ServerUrlCheck => ({ ok: false, error });
  if (typeof input !== 'string') return fail(t('serverUrl.empty'));
  const trimmed = input.trim();
  if (!trimmed) return fail(t('serverUrl.empty'));

  const scheme = ABSOLUTE_HTTP.exec(trimmed);
  if (!scheme) {
    return ANY_SCHEME.test(trimmed) && !/^https?:?\/?$/i.test(trimmed) && !/^[^:]+:\d/.test(trimmed)
      ? fail(t('serverUrl.scheme'))
      : fail(t('serverUrl.needScheme', { example: t('serverUrl.example') }));
  }

  const rest = trimmed.slice(scheme[0].length);
  const authority = rest.split(/[/?#]/, 1)[0];
  if (!authority) return fail(t('serverUrl.needHost', { example: t('serverUrl.example') }));
  if (authority.includes('@')) return fail(t('serverUrl.credentials'));
  if (/[?#]/.test(rest)) return fail(t('serverUrl.query'));

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return fail(t('serverUrl.invalid', { example: t('serverUrl.example') }));
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fail(t('serverUrl.scheme'));
  if (parsed.username || parsed.password) return fail(t('serverUrl.credentials'));
  if (!parsed.hostname) return fail(t('serverUrl.needHost', { example: t('serverUrl.example') }));

  let rawHost: string;
  let rawPort: string | undefined;
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end < 0) return fail(t('serverUrl.invalid', { example: t('serverUrl.example') }));
    rawHost = authority.slice(0, end + 1);
    const after = authority.slice(end + 1);
    if (after && !after.startsWith(':')) return fail(t('serverUrl.invalid', { example: t('serverUrl.example') }));
    rawPort = after ? after.slice(1) : undefined;
  } else {
    const colon = authority.indexOf(':');
    rawHost = colon < 0 ? authority : authority.slice(0, colon);
    rawPort = colon < 0 ? undefined : authority.slice(colon + 1);
  }
  if (rawPort !== undefined && !/^\d{1,5}$/.test(rawPort)) return fail(t('serverUrl.port'));
  if (!rawHost.startsWith('[')) {
    if (rawHost.endsWith('.') || rawHost.includes('..')) return fail(t('serverUrl.incompleteHost', { example: t('serverUrl.example') }));
    if (/^(0x[0-9a-f]*|[0-9.]+)$/i.test(rawHost) && parsed.hostname !== rawHost) {
      return fail(t('serverUrl.fullIp'));
    }
  }

  const pathname = parsed.pathname.replace(/\/+$/, '');
  const normalized = `${parsed.protocol}//${parsed.host}${pathname}`;

  // Mirror of electron/utils.ts validateServerUrl (SSRF + port policy).
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.includes(host) || host.endsWith('.metadata.google.internal') || /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return fail(t('serverUrl.blocked'));
  }
  if (host.startsWith('fe80:') || host.startsWith('fd00:') || host.startsWith('[fe80:') || host.startsWith('[fd00:')) {
    return fail(t('serverUrl.blocked'));
  }
  if (parsed.port && BLOCKED_PORTS.includes(parseInt(parsed.port, 10))) return fail(t('serverUrl.portBlocked', { port: parsed.port }));

  return { ok: true, url: normalized };
}

/** Same contract as electron/sync/serverUrl.ts normalizeServerUrl: normalised URL or null. */
export function normalizeServerUrl(input: unknown): string | null {
  const result = checkServerUrl(input);
  return result.ok ? result.url : null;
}
