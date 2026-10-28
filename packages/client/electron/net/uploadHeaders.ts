// DUN-064 / DUN-127: HTTP header values must be Latin-1, so a raw title such
// as "DARK SOULS™ III" or a CJK file name throws ERR_INVALID_CHAR before the
// request is sent. Every text header Desktop sends to the Dune Server is
// encodeURIComponent'd; the server decodes `x-game` and `x-path` once
// (server.ts decodeHeader) and answers 400 INVALID_HEADER_ENCODING on
// malformed input.

/** Headers whose values the server decodes with decodeURIComponent. */
export const ENCODED_UPLOAD_HEADERS = ['x-game', 'x-path'] as const;

export function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Headers for POST /api/upload-file. `x-sync-id` is a decimal timestamp
 * (ASCII by construction) and is not encoded; the server reads it raw.
 */
export function uploadFileHeaders(gameName: string, relativePath: string, syncId: string): Record<string, string> {
  if (!/^\d{1,20}$/.test(syncId)) throw new Error('Invalid sync id');
  return {
    'x-game': encodeHeaderValue(gameName),
    'x-path': encodeHeaderValue(relativePath),
    'x-sync-id': syncId,
    'Content-Type': 'application/octet-stream',
  };
}
