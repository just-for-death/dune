import { failure, isProviderError, type ProviderFailure, type ProviderResult } from './errors.js';
import type { EnabledSource, KeySource, ProviderId } from './types.js';

/** True only when the flag source returns exactly `true`; a throwing source counts as disabled. */
export async function isEnabled(source: EnabledSource): Promise<boolean> {
  try {
    return (await source()) === true;
  } catch {
    return false;
  }
}

export function disabledResult(provider: ProviderId): ProviderFailure {
  return failure('PROVIDER_DISABLED', `${provider} is disabled`);
}

/**
 * Run `fn` only when the provider is enabled. Disabled -> PROVIDER_DISABLED
 * before `fn` runs, so a disabled provider makes zero requests. A
 * ProviderError escaping `fn` becomes a typed failure, never a throw.
 */
export async function gated<T>(provider: ProviderId, enabled: EnabledSource, fn: () => Promise<ProviderResult<T>>): Promise<ProviderResult<T>> {
  if (!(await isEnabled(enabled))) return disabledResult(provider);
  try {
    return await fn();
  } catch (err) {
    if (isProviderError(err)) return failure(err.code, err.message);
    return failure('PROVIDER_UNAVAILABLE', `${provider} failed`);
  }
}

/** The key, or a PROVIDER_KEY_MISSING failure. The key is never logged or returned in results. */
export async function resolveKey(provider: ProviderId, source: KeySource | undefined): Promise<{ ok: true; key: string } | ProviderFailure> {
  let key: string | null | undefined;
  try {
    key = source ? await source() : null;
  } catch {
    key = null;
  }
  return typeof key === 'string' && key.length > 0 ? { ok: true, key } : failure('PROVIDER_KEY_MISSING', `${provider} API key not configured`);
}
