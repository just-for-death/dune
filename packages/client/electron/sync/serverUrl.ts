/**
 * DUN-045: the playtime queue may only be flushed to a saved, validated Dune
 * Server URL, never to a half-typed draft.
 *
 * The renderer persists `cloud.url` on every keystroke (config:save), so the
 * main process sees "h", "ht", ... "http://192.168.1.1", "http://192.168.1.10"
 * as separate saves. Two things keep the queue away from those drafts:
 *
 *  1. `normalizeServerUrl` only accepts complete, absolute http(s) URLs.
 *  2. `createPlaytimeFlushGate` waits until the saved URL has stopped changing
 *     (settled) before treating it as the saved server URL, and flushes only
 *     when `shouldFlushPlaytime` says the settled URL is valid and new.
 *
 * Everything here is free of Electron/store/network so it can be unit tested.
 */
import { validateServerUrl } from '../utils';

const ABSOLUTE_HTTP = /^(https?):\/\//i;

/**
 * Normalise a server URL, or return null when it is not a complete absolute
 * http/https URL that is safe to POST playtime to.
 *
 * Accepts:  `http://host`, `https://host:3030`, `http://host/base/` (trailing
 *           slashes stripped, surrounding whitespace trimmed).
 * Rejects:  empty input, scheme-less input (`localhost:3030`, `h`), any scheme
 *           other than http/https, credentials (`user:pw@`), query/fragment,
 *           an empty port (`http://host:`), WHATWG IPv4 shorthand that would
 *           silently turn into a different address (`http://192.168.` →
 *           192.0.0.168, `http://1` → 0.0.0.1), and anything the shared
 *           `validateServerUrl` blocks (metadata/link-local hosts, bad ports).
 */
export function normalizeServerUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const scheme = ABSOLUTE_HTTP.exec(trimmed);
  if (!scheme) return null;

  const rest = trimmed.slice(scheme[0].length);
  const authority = rest.split(/[/?#]/, 1)[0];
  if (!authority) return null;
  // Credentials (even an empty `@host`) and query/fragment are never valid
  // for a server base URL; the API path is appended to it.
  if (authority.includes('@')) return null;
  if (/[?#]/.test(rest)) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  if (!parsed.hostname) return null;

  // Split the host the user actually typed from its port.
  let rawHost: string;
  let rawPort: string | undefined;
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end < 0) return null;
    rawHost = authority.slice(0, end + 1);
    const after = authority.slice(end + 1);
    if (after && !after.startsWith(':')) return null;
    rawPort = after ? after.slice(1) : undefined;
  } else {
    const colon = authority.indexOf(':');
    rawHost = colon < 0 ? authority : authority.slice(0, colon);
    rawPort = colon < 0 ? undefined : authority.slice(colon + 1);
  }
  if (rawPort !== undefined && !/^\d{1,5}$/.test(rawPort)) return null;
  if (!rawHost.startsWith('[')) {
    if (rawHost.endsWith('.') || rawHost.includes('..')) return null;
    // Numeric hosts must be a full dotted quad; otherwise the URL parser
    // expands shorthand (`10.1` → 10.0.0.1) and we'd post to the wrong box.
    if (/^(0x[0-9a-f]*|[0-9.]+)$/i.test(rawHost) && parsed.hostname !== rawHost) return null;
  }

  const pathname = parsed.pathname.replace(/\/+$/, '');
  const normalized = `${parsed.protocol}//${parsed.host}${pathname}`;

  // Reuse the main-process SSRF / port policy for server URLs.
  const check = validateServerUrl(normalized);
  if (!check.valid) return null;
  return normalized;
}

/**
 * Decide whether saving `nextUrl` should flush the playtime queue: only when
 * the next URL is valid and differs from the previously saved, normalised URL.
 * Re-saving the same URL (or an equivalent spelling of it) never re-flushes;
 * an invalid URL never flushes.
 */
export function shouldFlushPlaytime(prevSavedUrl: unknown, nextUrl: unknown): boolean {
  const next = normalizeServerUrl(nextUrl);
  if (!next) return false;
  return next !== normalizeServerUrl(prevSavedUrl);
}

/** How long the server URL must stay unchanged before it counts as saved. */
export const SERVER_URL_SETTLE_MS = 1500;

export interface PlaytimeFlushGateOptions {
  /** URL already persisted when the app starts (may be invalid/empty). */
  initialUrl?: unknown;
  /** Called with the validated URL when a newly settled URL should be flushed to. */
  flush: (url: string) => void;
  settleMs?: number;
}

export interface PlaytimeFlushGate {
  /**
   * The saved, validated server URL playtime may be posted to, or null when
   * none is saved or the user is still editing it (a change is pending).
   */
  savedUrl(): string | null;
  /** Report a `cloud.url` value the renderer just persisted. */
  onUrlSaved(rawUrl: unknown): void;
  /** Cancel any pending settle timer. */
  dispose(): void;
}

/**
 * Turns per-keystroke `cloud.url` saves into at most one flush per real URL
 * change. Each save restarts a settle timer; when it fires, the URL becomes
 * the saved URL and the queue is flushed iff `shouldFlushPlaytime` allows it.
 * The gate never touches the queue itself, so invalid URLs can't drop items.
 */
export function createPlaytimeFlushGate(options: PlaytimeFlushGateOptions): PlaytimeFlushGate {
  const settleMs = options.settleMs ?? SERVER_URL_SETTLE_MS;
  let settled: string | null = normalizeServerUrl(options.initialUrl);
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  return {
    savedUrl: () => (timer ? null : settled),
    onUrlSaved(rawUrl: unknown) {
      const next = normalizeServerUrl(rawUrl);
      cancel();
      // Typed back to exactly the saved URL: nothing changed, nothing pending.
      if (next !== null && next === settled) return;
      timer = setTimeout(() => {
        timer = null;
        const flush = shouldFlushPlaytime(settled, next);
        settled = next;
        if (flush && next) options.flush(next);
      }, settleMs);
      (timer as { unref?: () => void }).unref?.();
    },
    dispose: cancel,
  };
}
