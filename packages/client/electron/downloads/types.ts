/**
 * Downloader engine types (Node-only, no Electron).
 *
 * The IPC-facing shapes live in @dune/shared (shared/src/downloads.ts) and are
 * re-exported here, so there is one source of truth. Engine-only types
 * (events, results, protocol handlers) stay below.
 *
 * The engine is content-agnostic: it ships with no sources, catalogs or
 * hardcoded URLs. A separate, user-configured source layer decides *what* to
 * download and hands the engine plain `DownloadRequest`s.
 */

import type {
  DownloadFailure,
  DownloadItem,
  DownloadProgress,
  DownloadSnapshot,
  DownloadStatus,
} from '@dune/shared';

export type {
  ChecksumAlgorithm,
  ChecksumSpec,
  DownloadErrorCode,
  DownloadFailure,
  DownloadItem,
  DownloadProgress,
  DownloadRequest,
  DownloadSettings,
  DownloadSnapshot,
  DownloadStatus,
} from '@dune/shared';

export type DownloadResult<T extends object = object> = ({ ok: true } & T) | DownloadFailure;

export interface DownloadEvents {
  added: (item: DownloadSnapshot) => void;
  /** Any status change. */
  status: (item: DownloadSnapshot, previous: DownloadStatus) => void;
  progress: (progress: DownloadProgress) => void;
  completed: (item: DownloadSnapshot) => void;
  failed: (item: DownloadSnapshot, error: DownloadFailure) => void;
  /** An automatic retry is scheduled after `delayMs`. */
  retrying: (item: DownloadSnapshot, attempt: number, delayMs: number, error: DownloadFailure) => void;
  removed: (id: string) => void;
  /** Persisting the queue failed (the in-memory queue keeps working). */
  persistError: (error: DownloadFailure) => void;
}

/** Context a protocol handler gets for one item. */
export interface ProtocolHandlerContext {
  item: Readonly<DownloadItem>;
  /** Write here; the manager verifies and renames it to `item.destPath`. */
  partPath: string;
  signal: AbortSignal;
  onProgress: (bytesDownloaded: number, totalBytes: number | null) => void;
}

/**
 * Pluggable handler for non-http(s) schemes (e.g. `magnet:`). The engine ships
 * none; a later layer may register one. Without a registered handler the
 * scheme is rejected with PROTOCOL_NOT_ALLOWED.
 */
export interface ProtocolHandler {
  id: string;
  /** Lowercase schemes with the trailing colon, e.g. `['magnet:']`. */
  protocols: readonly string[];
  /** Resolve when `partPath` holds the full file; reject (or honour `signal`) otherwise. */
  download(ctx: ProtocolHandlerContext): Promise<void>;
}
