import type { ServerFailure } from '@dune/shared';

// Dune UI contract: every IPC handler that calls the Dune Server returns a
// failure as { ok: false, status, code, message }.
// - status: the HTTP status of the server response; undefined when no
//   response arrived (then code is 'NETWORK').
// - code: the server body's `code`, passed through unchanged.
// - message: the server body's `error` (never axios's "Request failed with
//   status code 403" text).
// Server REST errors are exactly `{ error, code }` (server utils/apiError.ts).
// The server has no tRPC API (DUN-038), so no other error shape is parsed.

/**
 * DUN-068: every Dune Server request has a timeout, so a hung server can never
 * leave a handler (or the sync-in-progress flag) waiting forever.
 * JSON calls get SERVER_TIMEOUT_MS; file uploads/downloads TRANSFER_TIMEOUT_MS.
 * The shared axios instance is built in net/serverClient.ts.
 */
export const SERVER_TIMEOUT_MS = 15_000;
export const TRANSFER_TIMEOUT_MS = 5 * 60_000;

/** Code for a request that got no HTTP response (refused, DNS, timeout, reset). */
export const NETWORK_CODE = 'NETWORK';
/** Code when the server answered with an error but its body had no `code`. */
export const UNKNOWN_SERVER_CODE = 'SERVER_ERROR';
/** Code for a local (non-HTTP) failure inside a server-calling handler. */
export const LOCAL_ERROR_CODE = 'LOCAL_ERROR';

interface ResponseLike {
  status?: unknown;
  data?: unknown;
}

function bodyOf(data: unknown): Record<string, unknown> | null {
  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
  // responseType 'arraybuffer' (downloads): decode the JSON error body.
  // (axios gives a Buffer in Node; tag check because ArrayBuffers may come from another realm.)
  const isArrayBuffer = Object.prototype.toString.call(data) === '[object ArrayBuffer]';
  if (isArrayBuffer || ArrayBuffer.isView(data)) {
    const bytes = isArrayBuffer
      ? new Uint8Array(data as ArrayBuffer)
      : new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength);
    return bodyOf(new TextDecoder().decode(bytes));
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  return null;
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** A failure built from a server response that had an error body (or none). */
export function failureFromResponse(status: number | undefined, data: unknown): ServerFailure {
  const body = bodyOf(data);
  const code = nonEmpty(body?.code) ?? UNKNOWN_SERVER_CODE;
  const message = nonEmpty(body?.error)
    ?? nonEmpty(body?.message)
    ?? (status ? `Server error (HTTP ${status})` : 'Server error');
  return { ok: false, ...(status !== undefined ? { status } : {}), code, message };
}

/**
 * Map anything a server call threw (axios error, ServerCallError, plain
 * Error) to the contract shape. Duck-typed so it needs no axios import.
 */
export function toServerFailure(err: unknown): ServerFailure {
  if (err instanceof ServerCallError) return err.failure;
  const e = err as { response?: ResponseLike; message?: unknown } | null;
  const response = e && typeof e === 'object' ? e.response : undefined;
  if (response && typeof response === 'object') {
    const status = typeof response.status === 'number' ? response.status : undefined;
    return failureFromResponse(status, response.data);
  }
  const message = nonEmpty(e?.message) ?? String(err);
  const x = err as { isAxiosError?: unknown; request?: unknown; code?: unknown } | null;
  if (x && typeof x === 'object' && (x.isAxiosError === true || x.request !== undefined)) {
    // The request went out (or tried to) and no HTTP response came back.
    // DUN-068: a timeout is still NETWORK (no response), with a clear message.
    if (x.code === 'ECONNABORTED' || x.code === 'ETIMEDOUT') {
      return { ok: false, code: NETWORK_CODE, message: 'The Dune Server did not answer in time (request timed out).' };
    }
    return { ok: false, code: NETWORK_CODE, message: `Could not reach the Dune Server: ${message}` };
  }
  // A local failure (fs error, bug) while handling the call: never a server code.
  return { ok: false, code: LOCAL_ERROR_CODE, message };
}

/** Thrown inside multi-step flows so a server failure keeps its code. */
export class ServerCallError extends Error {
  readonly failure: ServerFailure;
  constructor(failure: ServerFailure) {
    super(failure.message);
    this.name = 'ServerCallError';
    this.failure = failure;
  }
}

/** Failure for a handler that needs a server URL but none is saved. */
export function noServerFailure(): ServerFailure {
  return { ok: false, code: 'NO_SERVER', message: 'No Dune Server configured' };
}

/** Success wrapper: the server body plus `ok: true`. */
export function serverOk<T extends object>(data: T): { ok: true } & T {
  return { ...(data && typeof data === 'object' ? data : ({} as T)), ok: true };
}

/**
 * Run one server call for an IPC handler: resolves to `{ ok: true, ...data }`
 * or the contract failure. Never rejects.
 */
export async function callServer<T extends object>(run: () => Promise<{ data: T }>): Promise<({ ok: true } & T) | ServerFailure> {
  try {
    const res = await run();
    return serverOk(res.data);
  } catch (err) {
    return toServerFailure(err);
  }
}
