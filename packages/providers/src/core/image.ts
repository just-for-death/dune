import { failure, success, type ProviderResult } from './errors.js';
import type { HttpResponse } from './types.js';

/** DUN-027: raster types only; never svg (scriptable) or html. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];
export const DEFAULT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export interface CheckedImage { bytes: Uint8Array; contentType: ImageType }

function sniff(b: Uint8Array): ImageType | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Validate an image download fetched through the guarded client with
 * responseType 'bytes' (so the host was already allow-listed): status 200,
 * declared content-type allowed, size within the cap, and the magic bytes
 * agree with the declared type.
 */
export function checkImageResponse(res: HttpResponse, opts: { maxBytes?: number; types?: readonly ImageType[] } = {}): ProviderResult<CheckedImage> {
  const maxBytes = opts.maxBytes ?? DEFAULT_IMAGE_MAX_BYTES;
  const types = opts.types ?? IMAGE_TYPES;
  if (res.status !== 200) return failure(res.status === 404 ? 'PROVIDER_NOT_FOUND' : 'PROVIDER_UNAVAILABLE', `image request failed (status ${res.status})`);
  const declared = (res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (!(types as readonly string[]).includes(declared)) return failure('PROVIDER_BAD_CONTENT_TYPE', `content-type not allowed: ${declared || 'none'}`);
  const length = Number(res.headers['content-length']);
  if (Number.isFinite(length) && length > maxBytes) return failure('PROVIDER_TOO_LARGE', `image exceeds ${maxBytes} bytes`);
  if (!(res.data instanceof Uint8Array)) return failure('PROVIDER_BAD_RESPONSE', 'image body is not bytes');
  if (res.data.byteLength > maxBytes) return failure('PROVIDER_TOO_LARGE', `image exceeds ${maxBytes} bytes`);
  if (sniff(res.data) !== declared) return failure('PROVIDER_BAD_CONTENT_TYPE', 'image bytes do not match content-type');
  return success({ bytes: res.data, contentType: declared as ImageType });
}
