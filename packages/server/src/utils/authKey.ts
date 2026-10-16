/**
 * Single source of truth for API-key extraction.
 * Used by both the REST `authMiddleware` and the tRPC context so the two
 * transports can never disagree about where a key comes from.
 *
 * Order: `x-api-key` header first (never logged), then `?api_key=` query
 * param (browser-driven fetches; may appear in access logs — prefer header).
 */
export function extractApiKey(
  headers: Record<string, string | string[] | undefined>,
  url?: string,
): string | null {
  const header = headers['x-api-key'];
  if (typeof header === 'string' && header.length > 0) return header;
  if (Array.isArray(header) && header.length > 0 && header[0].length > 0) return header[0];
  if (url) {
    const qIndex = url.indexOf('?');
    if (qIndex >= 0) {
      try {
        const q = new URLSearchParams(url.slice(qIndex + 1)).get('api_key');
        if (q) return q;
      } catch {
        return null;
      }
    }
  }
  return null;
}
