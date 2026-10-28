/**
 * Renderer view of the downloads IPC. Every shape comes from @dune/shared
 * (packages/shared/src/downloads.ts + ElectronAPI); this file only narrows
 * ElectronAPI to the members each component uses, so tests can pass fakes.
 */
import type { ElectronAPI } from '@dune/shared';

export type {
  DownloadIpcErrorCode,
  DownloadIpcFailure,
  DownloadIpcResult,
  DownloadSettings,
  DownloadSnapshot,
  DownloadStatus,
} from '@dune/shared';

/** What the queue (useDownloads / DownloadsQueue) needs. */
export type DownloadsQueueApi = Pick<
  ElectronAPI,
  | 'listDownloads'
  | 'pauseDownload'
  | 'resumeDownload'
  | 'cancelDownload'
  | 'retryDownload'
  | 'removeDownload'
  | 'onDownloadProgress'
  | 'onDownloadStatus'
  | 'onDownloadCompleted'
  | 'onDownloadFailed'
> &
  /** When present, rows get a "Show in folder" button that calls it directly. */
  Partial<Pick<ElectronAPI, 'showDownloadInFolder'>>;

/** What DownloadsSettingsPanel needs. */
export type DownloadsSettingsApi = Pick<
  ElectronAPI,
  'getDownloadSettings' | 'setDownloadConcurrency' | 'setDownloadAutoResume' | 'chooseDownloadBaseDir'
>;

/** Row actions; each maps to one per-item ElectronAPI method (see ACTION_METHODS). */
export type DownloadAction = 'pause' | 'resume' | 'cancel' | 'retry' | 'remove';

export const ACTION_METHODS = {
  pause: 'pauseDownload',
  resume: 'resumeDownload',
  cancel: 'cancelDownload',
  retry: 'retryDownload',
  remove: 'removeDownload',
} as const satisfies Record<DownloadAction, keyof DownloadsQueueApi>;

/** Everything the Downloads tab uses. */
export type DownloadsViewApi = DownloadsQueueApi & DownloadsSettingsApi;

const REQUIRED_METHODS = [
  'listDownloads', 'pauseDownload', 'resumeDownload', 'cancelDownload', 'retryDownload', 'removeDownload',
  'onDownloadProgress', 'onDownloadStatus', 'onDownloadCompleted', 'onDownloadFailed',
  'getDownloadSettings', 'setDownloadConcurrency', 'setDownloadAutoResume', 'chooseDownloadBaseDir',
] as const satisfies readonly Exclude<keyof DownloadsViewApi, 'showDownloadInFolder'>[];

/** False for a web/dev build (no bridge) or a bridge without the downloads IPC. */
export function hasDownloadsApi(api: Partial<DownloadsViewApi> | null | undefined): api is DownloadsViewApi {
  return !!api && REQUIRED_METHODS.every(m => typeof api[m] === 'function');
}
