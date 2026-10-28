import type { DownloadErrorCode, DownloadFailure } from './types';

/** Error thrown inside the engine; converted to a DownloadFailure at the edges. */
export class DownloadError extends Error {
  readonly code: DownloadErrorCode;
  readonly status?: number;
  /** Whether an automatic retry may help (network blips, 5xx, 408/429, truncation). */
  readonly retryable: boolean;
  /** Underlying error (set by hand: the electron tsconfig targets ES2020 lib). */
  readonly cause?: unknown;

  constructor(code: DownloadErrorCode, message: string, opts: { status?: number; retryable?: boolean; cause?: unknown } = {}) {
    super(message);
    if (opts.cause !== undefined) this.cause = opts.cause;
    this.name = 'DownloadError';
    this.code = code;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
  }

  toFailure(): DownloadFailure {
    return this.status !== undefined
      ? { ok: false, code: this.code, message: this.message, status: this.status }
      : { ok: false, code: this.code, message: this.message };
  }
}

export function fail(code: DownloadErrorCode, message: string, status?: number): DownloadFailure {
  return status !== undefined ? { ok: false, code, message, status } : { ok: false, code, message };
}

/** Normalise anything thrown into a DownloadError. */
export function toDownloadError(err: unknown, fallback: DownloadErrorCode = 'IO_ERROR'): DownloadError {
  if (err instanceof DownloadError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === 'ENOSPC') return new DownloadError('INSUFFICIENT_SPACE', 'Not enough disk space', { cause: err });
  if (typeof code === 'string' && /^(ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNABORTED)$/.test(code)) {
    return new DownloadError('NETWORK_ERROR', `${code}: ${message}`, { retryable: true, cause: err });
  }
  // An unclassified failure while talking to the server is treated as transient.
  return new DownloadError(fallback, message, { cause: err, retryable: fallback === 'NETWORK_ERROR' });
}
