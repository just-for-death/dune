/**
 * Downloader IPC contract (DUN downloads): the one source of truth for the
 * shapes main, preload and the renderer exchange. The engine
 * (client/electron/downloads) imports and re-exports these.
 *
 * The engine is content-agnostic: it ships no sources, catalogs or URLs.
 */

export type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'verifying'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ChecksumAlgorithm = 'sha256' | 'sha1' | 'md5';

export interface ChecksumSpec {
  algorithm: ChecksumAlgorithm;
  /** Hex digest (case-insensitive). */
  value: string;
}

export type DownloadErrorCode =
  | 'INVALID_URL'
  | 'URL_CREDENTIALS'
  | 'PROTOCOL_NOT_ALLOWED'
  | 'INVALID_PATH'
  | 'PATH_TRAVERSAL'
  | 'DUPLICATE_DEST'
  | 'INVALID_CHECKSUM'
  | 'INSUFFICIENT_SPACE'
  | 'HTTP_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'TOO_MANY_REDIRECTS'
  | 'SIZE_MISMATCH'
  | 'CHECKSUM_MISMATCH'
  | 'IO_ERROR'
  | 'HANDLER_ERROR'
  | 'NOT_FOUND'
  | 'INVALID_STATE';

/** ServerResult-style failure, so main can pass it straight through IPC. */
export interface DownloadFailure {
  ok: false;
  code: DownloadErrorCode;
  message: string;
  /** HTTP status for HTTP_ERROR. */
  status?: number;
}

/** What a caller (the source layer) asks for. */
export interface DownloadRequest {
  url: string;
  /**
   * File name, or a relative path, inside the destination folder. Defaults to
   * the last URL path segment. Never absolute, never escapes the folder.
   */
  fileName?: string;
  /**
   * Source id (one path segment, safePath rules). The default destination is
   * `<baseDir>/<source>/<fileName>`; persisted with the item.
   */
  source?: string;
  /**
   * Per-download destination folder override: an existing absolute directory.
   * Its realpath is recorded on the item (`destDir`) and replaces
   * `<baseDir>/<source>` for this download.
   */
  destDir?: string;
  /** Optional relative sub-folder inside the destination folder. */
  subdir?: string;
  checksum?: ChecksumSpec;
  /** Expected size in bytes; a server reporting a different size fails. */
  expectedSize?: number;
  /**
   * Replace an existing file at the destination. Default false: a taken name
   * is auto-renamed `name (1).ext`, `name (2).ext`, ...
   */
  overwrite?: boolean;
  /** Opaque caller data, persisted with the item. Keep it free of secrets. */
  meta?: Record<string, string | number | boolean | null>;
}

/** A queue entry, as persisted and as reported to listeners. */
export interface DownloadItem {
  id: string;
  url: string;
  /** Absolute final path (inside baseDir, or inside `destDir` when set). */
  destPath: string;
  /** Absolute temp path, `destPath + '.part'`. */
  partPath: string;
  /** Sanitised source id from the request. */
  source?: string;
  /** Realpath of the per-download folder override recorded at add(). */
  destDir?: string;
  /**
   * Realpath of the root this item was added under: `destDir` when set,
   * otherwise the base dir at add() time. Never created by the engine;
   * `destPath` must stay inside it. (Older entries without it fall back to
   * `destDir` or the current base dir on restore.)
   */
  root: string;
  /** Protocol handler id for non-http(s) URLs; undefined = built-in HTTP. */
  handler?: string;
  status: DownloadStatus;
  /** Enqueue order; the queue runs lowest first. */
  seq: number;
  bytesDownloaded: number;
  totalBytes: number | null;
  checksum?: ChecksumSpec;
  expectedSize?: number;
  overwrite?: boolean;
  meta?: DownloadRequest['meta'];
  /** Validators used for If-Range on resume. */
  etag?: string;
  lastModified?: string;
  /** Automatic retries used for the current attempt (reset by a manual retry). */
  attempts: number;
  /** Epoch ms before which a queued item waiting for an automatic retry won't start. */
  nextRetryAt?: number;
  error?: DownloadFailure;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface DownloadProgress {
  id: string;
  bytesDownloaded: number;
  totalBytes: number | null;
  /** Bytes per second over the recent window. */
  speed: number;
  /** Seconds remaining, or null when unknown (no total or no speed yet). */
  etaSeconds: number | null;
}

/**
 * What list()/get() and every item event return: the persisted item plus
 * fields derived for the UI (never persisted).
 */
export interface DownloadSnapshot extends DownloadItem {
  /** File name of `destPath`. */
  name: string;
  /** URL host (with port), or null for schemes without one (e.g. magnet:). */
  host: string | null;
  /** Same as `bytesDownloaded`. */
  receivedBytes: number;
  /** Bytes/second from the live meter; 0 when not transferring. */
  speed: number;
  /** Seconds remaining; null when unknown or not transferring (0 when complete). */
  eta: number | null;
  /** `error.code` of the last failure, or null. */
  errorCode: DownloadErrorCode | null;
}

/** Manager settings for the IPC layer. */
export interface DownloadSettings {
  baseDir: string;
  concurrency: number;
  maxConcurrency: number;
  autoResume: boolean;
}

/** `downloads:progress` event payload (throttled to ~4/s per item; a final one precedes every status change). */
export interface DownloadProgressEvent {
  item: DownloadSnapshot;
}

/** `downloads:status` event payload. */
export interface DownloadStatusEvent {
  item: DownloadSnapshot;
  previous: DownloadStatus;
}

/** `downloads:completed` event payload. */
export interface DownloadCompletedEvent {
  item: DownloadSnapshot;
}

/** `downloads:failed` event payload. */
export interface DownloadFailedEvent {
  item: DownloadSnapshot;
  error: DownloadFailure;
}

/**
 * Codes an IPC call can fail with: the engine's codes plus IPC-level ones.
 * INVALID_ARGUMENT: the renderer sent a malformed argument.
 * CANCELLED: the user closed a folder dialog.
 * NOT_READY: the download manager hasn't opened yet (or failed to).
 */
export const DOWNLOAD_IPC_ERROR_CODES = [
  // Engine codes (DownloadErrorCode)
  'INVALID_URL',
  'URL_CREDENTIALS',
  'PROTOCOL_NOT_ALLOWED',
  'INVALID_PATH',
  'PATH_TRAVERSAL',
  'DUPLICATE_DEST',
  'INVALID_CHECKSUM',
  'INSUFFICIENT_SPACE',
  'HTTP_ERROR',
  'NETWORK_ERROR',
  'TIMEOUT',
  'TOO_MANY_REDIRECTS',
  'SIZE_MISMATCH',
  'CHECKSUM_MISMATCH',
  'IO_ERROR',
  'HANDLER_ERROR',
  'NOT_FOUND',
  'INVALID_STATE',
  // IPC-level codes
  'INVALID_ARGUMENT',
  'CANCELLED',
  'NOT_READY',
] as const;

export type DownloadIpcErrorCode = (typeof DOWNLOAD_IPC_ERROR_CODES)[number];

// Compile-time guard: every engine code must stay in the runtime list.
type _EngineCodesListed = [DownloadErrorCode] extends [DownloadIpcErrorCode] ? true : never;
const _engineCodesListed: _EngineCodesListed = true;
void _engineCodesListed;

/** ServerFailure-compatible `{ ok: false, code, message, status? }`. */
export interface DownloadIpcFailure {
  ok: false;
  code: DownloadIpcErrorCode;
  message: string;
  status?: number;
}

export type DownloadIpcResult<T extends object = object> = ({ ok: true } & T) | DownloadIpcFailure;
