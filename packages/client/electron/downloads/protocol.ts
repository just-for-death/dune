/**
 * Protocol allow-list. Built in: http and https only. Other schemes (e.g.
 * `magnet:`) are accepted only when a ProtocolHandler for them has been
 * registered; the engine ships none.
 */
import { DownloadError } from './errors';
import type { ProtocolHandler } from './types';

export const BUILTIN_PROTOCOLS: readonly string[] = ['http:', 'https:'];

export interface ParsedDownloadUrl {
  url: URL;
  /** Undefined for built-in http(s). */
  handler?: ProtocolHandler;
}

export function parseDownloadUrl(raw: unknown, handlers: ReadonlyMap<string, ProtocolHandler>): ParsedDownloadUrl {
  if (typeof raw !== 'string' || !raw.trim()) throw new DownloadError('INVALID_URL', 'URL is required');
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new DownloadError('INVALID_URL', 'URL is not a valid absolute URL');
  }
  const protocol = url.protocol.toLowerCase();
  if (BUILTIN_PROTOCOLS.includes(protocol)) {
    if (!url.hostname) throw new DownloadError('INVALID_URL', 'URL has no host');
    // Credentials would be persisted in plain text in the queue file.
    if (url.username || url.password) throw new DownloadError('URL_CREDENTIALS', 'URLs with embedded credentials are not allowed');
    return { url };
  }
  const handler = handlers.get(protocol);
  if (handler) return { url, handler };
  throw new DownloadError('PROTOCOL_NOT_ALLOWED', `Protocol "${protocol}" is not allowed`);
}

/** True when `protocol` may be followed by an HTTP redirect. */
export function isRedirectAllowed(protocol: string): boolean {
  return BUILTIN_PROTOCOLS.includes(protocol.toLowerCase());
}
