/**
 * The one set of Dune Server URL rules (DUN-124), shared by the renderer
 * (src/services/serverUrl.ts) and the main process (electron/sync/serverUrl.ts).
 *
 * Pure: no Node or DOM imports; only the global WHATWG `URL`. Errors are
 * returned as codes so each side can word them itself (the renderer maps a
 * code to its i18n key `serverUrl.<code>`; `needScheme`, `needHost`,
 * `invalid` and `incompleteHost` take `{example}`, `portBlocked` takes `{port}`).
 *
 * The SSRF host list and port block list match the main process'
 * electron/utils.ts `validateServerUrl` (not the server's own validator).
 */

export type ServerUrlErrorCode =
  | 'empty'
  | 'scheme'
  | 'needScheme'
  | 'needHost'
  | 'credentials'
  | 'query'
  | 'invalid'
  | 'port'
  | 'incompleteHost'
  | 'fullIp'
  | 'blocked'
  | 'portBlocked';

export type ServerUrlCheck =
  | { ok: true; url: string }
  | { ok: false; code: ServerUrlErrorCode; port?: string };

/**
 * The parts of the global WHATWG `URL` used here. Declared locally because
 * this package compiles with lib ES2022 only (no DOM, no @types/node); the
 * runtime global exists in Node, Electron and browsers.
 */
interface ParsedUrl {
  readonly protocol: string;
  readonly username: string;
  readonly password: string;
  readonly hostname: string;
  readonly host: string;
  readonly port: string;
  readonly pathname: string;
}
declare const URL: new (input: string) => ParsedUrl;

const ABSOLUTE_HTTP = /^(https?):\/\//i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Cloud metadata endpoints that are never a Dune Server. */
export const BLOCKED_SERVER_HOSTS: readonly string[] = [
  '169.254.169.254',
  'metadata.google.internal',
  '100.100.100.200',
  '169.254.169.253',
  'instance-data',
];

/** Well-known non-HTTP service ports. */
export const BLOCKED_SERVER_PORTS: readonly number[] = [21, 22, 23, 25, 53, 69, 110, 119, 123, 143, 161, 194, 445];

/**
 * Validate and normalise a Dune Server base URL.
 *
 * Accepts complete absolute http/https URLs only (`http://host`,
 * `https://host:3030`, `http://host/base/`); trims whitespace, lowercases
 * scheme/host, drops a default port and trailing slashes.
 * Rejects: empty or non-string input, scheme-less input, other schemes,
 * credentials (even an empty `@host`), query/fragment, an empty or
 * non-numeric port, hosts ending in `.` or containing `..`, IPv4 shorthand
 * the URL parser would silently expand (`http://10.1` → 10.0.0.1), cloud
 * metadata / link-local hosts, and blocked ports.
 */
export function checkServerUrl(input: unknown): ServerUrlCheck {
  const fail = (code: ServerUrlErrorCode): ServerUrlCheck => ({ ok: false, code });
  if (typeof input !== 'string') return fail('empty');
  const trimmed = input.trim();
  if (!trimmed) return fail('empty');

  const scheme = ABSOLUTE_HTTP.exec(trimmed);
  if (!scheme) {
    // A real non-http scheme (`ftp:`, `javascript:`) vs. a half-typed http
    // scheme or a scheme-less `host:port`.
    return ANY_SCHEME.test(trimmed) && !/^https?:?\/?$/i.test(trimmed) && !/^[^:]+:\d/.test(trimmed)
      ? fail('scheme')
      : fail('needScheme');
  }

  const rest = trimmed.slice(scheme[0].length);
  const authority = rest.split(/[/?#]/, 1)[0] ?? '';
  if (!authority) return fail('needHost');
  if (authority.includes('@')) return fail('credentials');
  if (/[?#]/.test(rest)) return fail('query');

  let parsed: ParsedUrl;
  try {
    parsed = new URL(trimmed);
  } catch {
    return fail('invalid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fail('scheme');
  if (parsed.username || parsed.password) return fail('credentials');
  if (!parsed.hostname) return fail('needHost');

  // Split the host the user actually typed from its port.
  let rawHost: string;
  let rawPort: string | undefined;
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end < 0) return fail('invalid');
    rawHost = authority.slice(0, end + 1);
    const after = authority.slice(end + 1);
    if (after && !after.startsWith(':')) return fail('invalid');
    rawPort = after ? after.slice(1) : undefined;
  } else {
    const colon = authority.indexOf(':');
    rawHost = colon < 0 ? authority : authority.slice(0, colon);
    rawPort = colon < 0 ? undefined : authority.slice(colon + 1);
  }
  if (rawPort !== undefined && !/^\d{1,5}$/.test(rawPort)) return fail('port');
  if (!rawHost.startsWith('[')) {
    if (rawHost.endsWith('.') || rawHost.includes('..')) return fail('incompleteHost');
    // Numeric hosts must be a full dotted quad; otherwise the URL parser
    // expands shorthand and we'd talk to a different machine.
    if (/^(0x[0-9a-f]*|[0-9.]+)$/i.test(rawHost) && parsed.hostname !== rawHost) return fail('fullIp');
  }

  const pathname = parsed.pathname.replace(/\/+$/, '');
  const normalized = `${parsed.protocol}//${parsed.host}${pathname}`;

  // SSRF + port policy (same lists as electron/utils.ts validateServerUrl).
  const host = parsed.hostname.toLowerCase();
  if (
    BLOCKED_SERVER_HOSTS.includes(host) ||
    host.endsWith('.metadata.google.internal') ||
    /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)
  ) {
    return fail('blocked');
  }
  if (host.startsWith('fe80:') || host.startsWith('fd00:') || host.startsWith('[fe80:') || host.startsWith('[fd00:')) {
    return fail('blocked');
  }
  if (parsed.port && BLOCKED_SERVER_PORTS.includes(parseInt(parsed.port, 10))) {
    return { ok: false, code: 'portBlocked', port: parsed.port };
  }

  return { ok: true, url: normalized };
}

/** The normalised server URL, or null when `checkServerUrl` rejects it. */
export function normalizeServerUrl(input: unknown): string | null {
  const result = checkServerUrl(input);
  return result.ok ? result.url : null;
}
