export const PROVIDER_ERROR_CODES = [
  'PROVIDER_DISABLED',
  'PROVIDER_KEY_MISSING',
  'PROVIDER_HOST_BLOCKED',
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_NOT_FOUND',
  'PROVIDER_BAD_RESPONSE',
  'PROVIDER_TOO_LARGE',
  'PROVIDER_BAD_CONTENT_TYPE',
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

/** Thrown inside the package (guard, transport); public APIs return ProviderResult instead. */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly status?: number;

  constructor(code: ProviderErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export function isProviderError(err: unknown): err is ProviderError {
  return err instanceof ProviderError;
}

export type ProviderSuccess<T> = { ok: true; value: T; stale?: boolean };
export type ProviderFailure = { ok: false; code: ProviderErrorCode; message: string };
export type ProviderResult<T> = ProviderSuccess<T> | ProviderFailure;

export function success<T>(value: T, stale = false): ProviderSuccess<T> {
  return stale ? { ok: true, value, stale: true } : { ok: true, value };
}

export function failure(code: ProviderErrorCode, message: string): ProviderFailure {
  return { ok: false, code, message };
}

/** Map an HTTP status to the code a provider reports when it cannot use the response. */
export function codeForStatus(status: number): ProviderErrorCode {
  if (status === 404) return 'PROVIDER_NOT_FOUND';
  if (status === 429) return 'PROVIDER_RATE_LIMITED';
  if (status === 401 || status === 403) return 'PROVIDER_KEY_MISSING';
  return 'PROVIDER_UNAVAILABLE';
}
