import type {
  DownloadCompletedEvent, DownloadFailedEvent, DownloadProgressEvent, DownloadStatusEvent,
} from '@dune/shared';
import type { DownloadIpcResult, DownloadSnapshot, DownloadsQueueApi } from './types';

export function snap(over: Partial<DownloadSnapshot> = {}): DownloadSnapshot {
  return {
    id: 'a', url: 'https://cdn.example.com/game.zip', destPath: '/dl/steam/game.zip', partPath: '/dl/steam/game.zip.part',
    root: '/dl/steam', source: 'steam', status: 'downloading', seq: 1, bytesDownloaded: 512, totalBytes: 1024, attempts: 0,
    createdAt: '2026-10-28T10:00:00.000Z', updatedAt: '2026-10-28T10:00:00.000Z',
    name: 'game.zip', host: 'cdn.example.com', receivedBytes: 512, speed: 2048, eta: 30, errorCode: null,
    ...over,
  };
}

type Subs = {
  progress: Set<(e: DownloadProgressEvent) => void>;
  status: Set<(e: DownloadStatusEvent) => void>;
  completed: Set<(e: DownloadCompletedEvent) => void>;
  failed: Set<(e: DownloadFailedEvent) => void>;
};

/** Fake of the queue's ElectronAPI slice; per-item actions resolve { ok: true, item } like main does. */
export function fakeApi(listResult: Promise<DownloadIpcResult<{ items: DownloadSnapshot[] }>> = Promise.resolve({ ok: true, items: [] })) {
  const subs: Subs = { progress: new Set(), status: new Set(), completed: new Set(), failed: new Set() };
  const on = <E>(set: Set<(e: E) => void>) => (cb: (e: E) => void) => { set.add(cb); return () => { set.delete(cb); }; };
  const ok = async (id: string) => ({ ok: true as const, item: snap({ id }) });
  const api: DownloadsQueueApi = {
    listDownloads: () => listResult,
    pauseDownload: ok, resumeDownload: ok, cancelDownload: ok, retryDownload: ok, removeDownload: ok,
    onDownloadProgress: on(subs.progress),
    onDownloadStatus: on(subs.status),
    onDownloadCompleted: on(subs.completed),
    onDownloadFailed: on(subs.failed),
  };
  /** Sends the real payload shape: { item }, plus `previous` (status) or `error` (failed). */
  const emit = (kind: keyof Subs, item: DownloadSnapshot, error?: DownloadFailedEvent['error']) => {
    if (kind === 'status') for (const cb of [...subs.status]) cb({ item, previous: 'downloading' });
    else if (kind === 'failed') {
      const err = error ?? { ok: false, code: item.errorCode ?? 'NETWORK_ERROR', message: '' };
      for (const cb of [...subs.failed]) cb({ item, error: err });
    } else for (const cb of [...subs[kind]]) cb({ item });
  };
  const count = () => subs.progress.size + subs.status.size + subs.completed.size + subs.failed.size;
  return { api, emit, count };
}

/** Manual frame scheduler: flushes only when run() is called. */
export function manualSchedule() {
  const queue: (() => void)[] = [];
  const schedule = (fn: () => void) => { queue.push(fn); return () => { const i = queue.indexOf(fn); if (i >= 0) queue.splice(i, 1); }; };
  const run = () => { const fns = queue.splice(0); fns.forEach(f => f()); };
  return { schedule, run, pending: () => queue.length };
}

export const tick = () => new Promise(r => setTimeout(r, 0));
