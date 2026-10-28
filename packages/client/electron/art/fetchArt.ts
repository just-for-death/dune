import * as nodePath from 'path';
import type { FetchArtResult } from '@dune/shared';
import { TRANSFER_TIMEOUT_MS, toServerFailure } from '../net/serverError';
import type { ServerClient, ServerHttp } from '../net/serverClient';

/**
 * game:fetchArt through the Dune Server (DUN-092, DUN-036/027 key in one
 * place). Main no longer keeps its own SteamGridDB key or calls SteamGridDB
 * with it: the server searches with its write-only provider key
 * (`/api/search-art`; PROVIDER_KEY_NOT_SET / 403 pass through unchanged),
 * and main downloads only an https image from a steamgriddb.com host, with a
 * size cap, no redirects and an image content-type, into thumbDir.
 */
export const MAX_ART_BYTES = 10 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

export function isAllowedArtUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  return host === 'steamgriddb.com' || host.endsWith('.steamgriddb.com');
}

export interface FetchArtDeps {
  client: ServerClient;
  /** Plain HTTP for the image download (no x-api-key is ever sent to the CDN). */
  http: ServerHttp;
  thumbDir: string;
  writeFile: (file: string, data: Buffer) => void;
}

export async function fetchArtViaServer(gameId: number, name: string, deps: FetchArtDeps): Promise<FetchArtResult> {
  const search = await deps.client.call<{ results?: unknown }>({ method: 'GET', path: '/api/search-art', query: { query: name } });
  if (!search.ok) return search;
  const results = Array.isArray(search.results) ? search.results : [];
  if (results.length === 0) return { ok: false, code: 'ART_NOT_FOUND', message: 'No cover art found on SteamGridDB.' };
  const url = results[0];
  if (!isAllowedArtUrl(url)) return { ok: false, code: 'ART_URL_REJECTED', message: 'The art URL is not a SteamGridDB image.' };
  try {
    const res = await deps.http.request<ArrayBuffer>({
      method: 'GET',
      url,
      responseType: 'arraybuffer',
      timeout: TRANSFER_TIMEOUT_MS,
      maxContentLength: MAX_ART_BYTES,
      maxRedirects: 0,
    });
    const type = String((res.headers as Record<string, unknown> | undefined)?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const ext = IMAGE_TYPES[type];
    if (!ext) return { ok: false, code: 'ART_NOT_IMAGE', message: 'The downloaded art is not an image.' };
    const data = Buffer.from(res.data);
    if (data.length === 0 || data.length > MAX_ART_BYTES) return { ok: false, code: 'ART_TOO_LARGE', message: 'The art image is empty or too large.' };
    const target = nodePath.join(deps.thumbDir, `${gameId}${ext}`);
    deps.writeFile(target, data);
    return { ok: true, thumbnail: `local://${target}` };
  } catch (err) {
    return toServerFailure(err);
  }
}
