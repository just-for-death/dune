/** Core contracts shared by every provider. Nothing here does I/O itself. */

export type MaybePromise<T> = T | Promise<T>;

export type ProviderId =
  | 'hltb' | 'steamgriddb' | 'appUpdate'
  | 'steam' | 'retroAchievements' | 'gog' | 'epic'
  | 'manifest';

export type HttpMethod = 'GET' | 'POST';
export type ResponseType = 'text' | 'json' | 'bytes';

export interface HttpRequest {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  /** JSON-serialisable body (objects are sent as JSON) or a pre-encoded string. */
  body?: unknown;
  responseType: ResponseType;
  timeoutMs: number;
  /** Hard cap on the response body; larger bodies fail with PROVIDER_TOO_LARGE. */
  maxBytes: number;
}

export interface HttpResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  /** string for 'text', parsed JSON (or the raw string if it is not JSON) for 'json', Uint8Array for 'bytes'. */
  data: unknown;
}

/**
 * Injected HTTP. Contract: resolve with ANY status (never throw on 4xx/5xx),
 * never follow redirects (the guarded client does, re-checking the host),
 * honour timeoutMs and maxBytes, and throw only when the request itself failed.
 * The server passes an axios adapter, Electron main `fetchTransport(net.fetch)`.
 */
export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;

/** Injected key lookup (server: encrypted providerKeys; Electron: safeStorage). Never stored here. */
export type KeySource = () => MaybePromise<string | null | undefined>;

/** Injected enable flag, read on every call. Anything but `true` means disabled. */
export type EnabledSource = () => MaybePromise<boolean>;

export interface CacheEntry<T> {
  value: T;
  /** Epoch ms the value was stored (server file cache: the file mtime). */
  storedAt: number;
}

/** Injected cache; sync or async. Implementations should not throw, but callers guard anyway. */
export interface ProviderCache<T> {
  get(key: string): MaybePromise<CacheEntry<T> | null>;
  set(key: string, value: T): MaybePromise<void>;
}

/** pino-compatible subset. Providers only ever pass redacted fields. */
export interface ProviderLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export const noopLogger: ProviderLogger = { info: () => {}, warn: () => {} };
