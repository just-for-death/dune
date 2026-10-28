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
 * Store ids for POST /api/upload-file (server FEAT-server-storeIds). Same
 * pattern as the server's STORE_ID_PATTERN; anything else would be a 400
 * INVALID_STORE_ID, so it is left out (absent = server keeps its value).
 */
export const UPLOAD_STORE_ID_PATTERN = /^[1-9][0-9]{0,11}$/;

export interface UploadStoreIds {
  steamAppId?: string | null;
  gogId?: string | null;
}

/**
 * Headers for POST /api/upload-file. `x-sync-id` is a decimal timestamp
 * (ASCII by construction) and is not encoded; the server reads it raw.
 * `x-steam-app-id` / `x-gog-id` are sent only for valid digit-string ids.
 */
export function uploadFileHeaders(gameName: string, relativePath: string, syncId: string, ids: UploadStoreIds = {}): Record<string, string> {
  if (!/^\d{1,20}$/.test(syncId)) throw new Error('Invalid sync id');
  const valid = (v: unknown): v is string => typeof v === 'string' && UPLOAD_STORE_ID_PATTERN.test(v);
  return {
    'x-game': encodeHeaderValue(gameName),
    'x-path': encodeHeaderValue(relativePath),
    'x-sync-id': syncId,
    ...(valid(ids.steamAppId) ? { 'x-steam-app-id': ids.steamAppId } : {}),
    ...(valid(ids.gogId) ? { 'x-gog-id': ids.gogId } : {}),
    'Content-Type': 'application/octet-stream',
  };
}
