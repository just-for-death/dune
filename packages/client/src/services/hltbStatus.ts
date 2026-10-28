/** Code the Dune server uses when a provider opt-in (Settings.hltbEnabled, Settings.artworkEnabled) is off. */
export const PROVIDER_DISABLED = 'PROVIDER_DISABLED';

/**
 * True when a server call says the provider is turned off: HTTP 403
 * `{ error, code: 'PROVIDER_DISABLED' }`, mapped by main to a ServerFailure
 * `{ ok: false, status: 403, code }`. Main's own local pre-check sends the
 * same code without a status. Anything else (FORBIDDEN, other codes, other
 * statuses) is a real failure.
 */
export function isProviderDisabled(res: unknown): boolean {
  if (!res || typeof res !== 'object' || res instanceof Error) return false;
  const r = res as { ok?: unknown; status?: unknown; code?: unknown };
  return r.ok === false && r.code === PROVIDER_DISABLED && (r.status === undefined || r.status === 403);
}
