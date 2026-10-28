/**
 * Single source of truth for API-key extraction.
 * Used by both the REST `authMiddleware` and the tRPC context so the two
 * transports can never disagree about where a key comes from.
 *
 * DUN-102: the `x-api-key` header is the ONLY accepted carrier. A key in the
 * URL (`?api_key=`) ends up in access logs, proxies and browser history, so
 * such requests are refused outright (see `hasQueryApiKey` /
 * middleware/security.ts rejectQueryApiKey -> 400 API_KEY_IN_QUERY).
 */
export function extractApiKey(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const header = headers['x-api-key'];
  if (typeof header === 'string' && header.length > 0) return header;
  if (Array.isArray(header) && header.length > 0 && header[0].length > 0) return header[0];
  return null;
}

/** True when the URL's query string carries an `api_key` parameter (any value). */
export function hasQueryApiKey(url: string | undefined): boolean {
  if (!url) return false;
  const qIndex = url.indexOf('?');
  if (qIndex < 0) return false;
  try {
    return new URLSearchParams(url.slice(qIndex + 1)).has('api_key');
  } catch {
    return false;
  }
}
