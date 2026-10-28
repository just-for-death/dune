import axios, { type AxiosInstance, type AxiosResponse } from 'axios';
import type { ServerFailure, ServerResult } from '@dune/shared';
import {
  SERVER_TIMEOUT_MS,
  TRANSFER_TIMEOUT_MS,
  ServerCallError,
  noServerFailure,
  serverOk,
  toServerFailure,
} from './serverError';

/**
 * The one way main talks to the Dune Server.
 *
 * - DUN-121: the base URL always comes from `baseUrl()`, which main wires to
 *   the saved, gated URL from sync/serverUrl.ts. Nothing here ever reads the
 *   draft `cloud.url` or adds a scheme to half-typed input. No saved URL means
 *   NO_SERVER and no request.
 * - DUN-068: one shared axios instance with a timeout; transfers (uploads and
 *   downloads) get the longer TRANSFER_TIMEOUT_MS.
 * - DUN-072: path segments go through `seg()`, which encodes them and refuses
 *   empty, `.` and `..`, so renderer input can never retarget a request.
 */

export type ServerMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface ServerRequest {
  method: ServerMethod;
  /** Absolute API path, e.g. `/api/save-versions/${seg(id)}`. */
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** File upload/download: uses TRANSFER_TIMEOUT_MS. */
  transfer?: boolean;
  responseType?: 'json' | 'arraybuffer';
}

export type ServerHttp = Pick<AxiosInstance, 'request'>;

export interface ServerClientDeps {
  http: ServerHttp;
  /** The saved, validated server URL (sync/serverUrl.ts gate), or null. */
  baseUrl: () => string | null;
  /** The x-api-key value ('' when none is stored). */
  apiKey: () => string;
}

export interface ServerClient {
  baseUrl(): string | null;
  /** Raw response; throws ServerCallError (NO_SERVER / INVALID_ARGUMENT) or the axios error. */
  raw<T = unknown>(req: ServerRequest): Promise<AxiosResponse<T>>;
  /** `{ ok: true, ...body }` or the contract failure. Never rejects. */
  call<T extends object = Record<string, unknown>>(req: ServerRequest): Promise<ServerResult<T>>;
}

export const INVALID_ARGUMENT_CODE = 'INVALID_ARGUMENT';

export function invalidArgument(message: string): ServerFailure {
  return { ok: false, code: INVALID_ARGUMENT_CODE, message };
}

/** One URL path segment from (possibly renderer-supplied) input. */
export function seg(value: string | number): string {
  const raw = String(value);
  if (raw === '' || raw === '.' || raw === '..' || raw.length > 512) {
    throw new ServerCallError(invalidArgument('Invalid id'));
  }
  return encodeURIComponent(raw);
}

/** The shared axios instance for Dune Server calls (DUN-068). */
export function createServerHttp(): AxiosInstance {
  return axios.create({ timeout: SERVER_TIMEOUT_MS });
}

const API_PATH = /^\/api\/[^?#]*$/;

export function createServerClient(deps: ServerClientDeps): ServerClient {
  const raw = async <T>(req: ServerRequest): Promise<AxiosResponse<T>> => {
    const base = deps.baseUrl();
    if (!base) throw new ServerCallError(noServerFailure());
    if (!API_PATH.test(req.path) || req.path.split('/').some((s) => s === '.' || s === '..')) {
      throw new ServerCallError(invalidArgument('Invalid server path'));
    }
    const key = deps.apiKey();
    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    if (req.body !== undefined && !headers['Content-Type'] && isJsonBody(req.body)) headers['Content-Type'] = 'application/json';
    if (key) headers['x-api-key'] = key;
    const query = req.query
      ? Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== undefined))
      : undefined;
    return deps.http.request<T>({
      method: req.method,
      url: `${base}${req.path}`,
      ...(query && Object.keys(query).length > 0 ? { params: query } : {}),
      ...(req.body !== undefined ? { data: req.body } : {}),
      headers,
      timeout: req.transfer ? TRANSFER_TIMEOUT_MS : SERVER_TIMEOUT_MS,
      ...(req.responseType ? { responseType: req.responseType } : {}),
    });
  };
  return {
    baseUrl: () => deps.baseUrl(),
    raw,
    async call<T extends object>(req: ServerRequest): Promise<ServerResult<T>> {
      try {
        const res = await raw<T>(req);
        return serverOk(res.data);
      } catch (err) {
        return toServerFailure(err);
      }
    },
  };
}

function isJsonBody(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return false;
  // Streams and buffers (uploads) set their own headers.
  if (typeof (body as { pipe?: unknown }).pipe === 'function') return false;
  return !ArrayBuffer.isView(body);
}
