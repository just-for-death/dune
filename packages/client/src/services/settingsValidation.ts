/** Validation for Settings fields that are saved without an explicit Save button. */
import { checkServerUrl } from './serverUrl';

export type Validation = { ok: true; value: string } | { ok: false; error: string };

/**
 * Server address field. Same rules as the main process
 * (see ./serverUrl.ts, mirroring electron/sync/serverUrl.ts). The saved value
 * is the normalised URL. An empty value is valid and means "no server".
 */
export function validateServerUrl(input: string): Validation {
  if (!input.trim()) return { ok: true, value: '' };
  const result = checkServerUrl(input);
  return result.ok ? { ok: true, value: result.url } : { ok: false, error: result.error };
}

/** Keys are opaque tokens: trimmed, no inner whitespace. Empty clears the key. */
export function validateApiKey(input: string): Validation {
  const value = input.trim();
  if (/\s/.test(value)) return { ok: false, error: 'Keys cannot contain spaces.' };
  return { ok: true, value };
}
