/**
 * Framework-free store behind useDownloads: loads the queue, merges pushed
 * snapshots ({ item } events) by id, and coalesces bursts of events into one
 * update per frame.
 */
import type { DownloadFailedEvent } from '@dune/shared';
import { ACTION_METHODS, type DownloadAction, type DownloadSnapshot, type DownloadsQueueApi } from './types';

export type Schedule = (flush: () => void) => () => void;

export interface DownloadsAnnouncement {
  /** Increments per announcement so identical text is re-announced. */
  seq: number;
  kind: 'completed' | 'failed';
  id: string;
  name: string;
  code: string | null;
}

export interface DownloadsState {
  phase: 'loading' | 'ready' | 'error';
  items: DownloadSnapshot[];
  /** Code of the list() failure while phase === 'error'. */
  loadError: string | null;
  /** Per-row action failures by id. */
  actionErrors: Readonly<Record<string, string>>;
  /** Ids with an action in flight (buttons are aria-disabled meanwhile). */
  busy: Readonly<Record<string, DownloadAction>>;
  /** Only completions and failures — never progress ticks. */
  announcement: DownloadsAnnouncement | null;
}

export interface DownloadsStore {
  getState(): DownloadsState;
  subscribe(listener: () => void): () => void;
  start(): void;
  reload(): void;
  act(id: string, action: DownloadAction): Promise<boolean>;
  /**
   * Calls api.showDownloadInFolder(id); a failure lands in actionErrors[id].
   * Resolves false (and does nothing) when the api has no such method.
   */
  showInFolder(id: string): Promise<boolean>;
  dispose(): void;
}

export const INITIAL_DOWNLOADS_STATE: DownloadsState = {
  phase: 'loading',
  items: [],
  loadError: null,
  actionErrors: {},
  busy: {},
  announcement: null,
};

/** requestAnimationFrame when available, else a ~frame timeout. */
export const frameSchedule: Schedule = flush => {
  if (typeof requestAnimationFrame === 'function') {
    const handle = requestAnimationFrame(() => flush());
    return () => cancelAnimationFrame(handle);
  }
  const handle = setTimeout(flush, 16);
  return () => clearTimeout(handle);
};

/** Newer wins; equal updatedAt (progress ticks) also wins because it arrived later. */
function newer(existing: DownloadSnapshot | undefined, incoming: DownloadSnapshot): boolean {
  if (!existing) return true;
  return !(existing.updatedAt && incoming.updatedAt && existing.updatedAt > incoming.updatedAt);
}

type Pending = { kind: 'progress' | 'status' | 'completed' | 'failed'; item: DownloadSnapshot };

/** Applies queued events in arrival order. Progress for an unknown id is ignored. */
export function mergeEvents(items: readonly DownloadSnapshot[], events: readonly Pending[]): DownloadSnapshot[] {
  const next = items.slice();
  const index = new Map(next.map((item, i) => [item.id, i]));
  for (const { kind, item } of events) {
    if (!item || typeof item.id !== 'string') continue;
    const at = index.get(item.id);
    if (at === undefined) {
      if (kind === 'progress') continue;
      index.set(item.id, next.length);
      next.push(item);
    } else if (newer(next[at], item)) {
      next[at] = { ...next[at], ...item };
    }
  }
  return next;
}

/** True when the api can reveal an item itself (the queue then shows "Show in folder"). */
export function canShowInFolder(api: Pick<DownloadsQueueApi, 'showDownloadInFolder'>): boolean {
  return typeof api.showDownloadInFolder === 'function';
}

export function createDownloadsStore(api: DownloadsQueueApi, schedule: Schedule = frameSchedule): DownloadsStore {
  let state: DownloadsState = INITIAL_DOWNLOADS_STATE;
  const listeners = new Set<() => void>();
  let unsubs: (() => void)[] = [];
  let pending: Pending[] = [];
  let pendingAnnouncements: Omit<DownloadsAnnouncement, 'seq'>[] = [];
  let cancelFlush: (() => void) | null = null;
  let announceSeq = 0;
  let generation = 0;
  let active = false;

  const set = (patch: Partial<DownloadsState>) => {
    state = { ...state, ...patch };
    for (const l of [...listeners]) l();
  };

  const flush = () => {
    cancelFlush = null;
    if (!active || state.phase !== 'ready') return;
    if (pending.length === 0 && pendingAnnouncements.length === 0) return;
    const events = pending;
    pending = [];
    const items = mergeEvents(state.items, events);
    let actionErrors = state.actionErrors;
    for (const e of events) {
      if (e.kind !== 'progress' && actionErrors[e.item.id]) {
        const { [e.item.id]: _dropped, ...rest } = actionErrors;
        void _dropped;
        actionErrors = rest;
      }
    }
    const last = pendingAnnouncements.length > 0 ? pendingAnnouncements[pendingAnnouncements.length - 1] : undefined;
    pendingAnnouncements = [];
    set({
      items,
      actionErrors,
      announcement: last ? { ...last, seq: ++announceSeq } : state.announcement,
    });
  };

  /** Every event carries { item }; failed events also carry `error`. */
  const queue = (kind: Pending['kind']) => (event: { item: DownloadSnapshot; error?: DownloadFailedEvent['error'] }) => {
    const item = event?.item;
    if (!active || !item || typeof item.id !== 'string') return;
    pending.push({ kind, item });
    if (kind === 'completed' || kind === 'failed') {
      const code = kind === 'failed' ? (event.error?.code ?? item.errorCode ?? item.error?.code ?? null) : null;
      pendingAnnouncements.push({ kind, id: item.id, name: item.name, code });
    }
    // Until list() resolves, events are buffered and replayed on top of it.
    if (state.phase === 'ready' && !cancelFlush) cancelFlush = schedule(flush);
  };

  const load = () => {
    const gen = ++generation;
    if (state.phase !== 'loading') set({ phase: 'loading', loadError: null });
    api.listDownloads().then(
      res => {
        if (!active || gen !== generation) return;
        if (res.ok) {
          set({ phase: 'ready', items: Array.isArray(res.items) ? res.items : [], loadError: null });
          if ((pending.length || pendingAnnouncements.length) && !cancelFlush) cancelFlush = schedule(flush);
        } else {
          set({ phase: 'error', loadError: res.code || 'unknown' });
        }
      },
      () => {
        if (active && gen === generation) set({ phase: 'error', loadError: 'unknown' });
      },
    );
  };

  const clearRowError = (id: string) => {
    const { [id]: _prev, ...rest } = state.actionErrors;
    void _prev;
    return rest;
  };

  const dispose = () => {
    active = false;
    generation++;
    for (const u of unsubs) {
      try { u(); } catch { /* already gone */ }
    }
    unsubs = [];
    cancelFlush?.();
    cancelFlush = null;
    pending = [];
    pendingAnnouncements = [];
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    start() {
      if (active) return;
      active = true;
      // Subscribe first so nothing between list() and subscription is lost.
      unsubs = [
        api.onDownloadProgress(queue('progress')),
        api.onDownloadStatus(queue('status')),
        api.onDownloadCompleted(queue('completed')),
        api.onDownloadFailed(queue('failed')),
      ];
      load();
    },
    reload() {
      if (active) load();
    },
    async act(id, action) {
      if (!active || state.busy[id]) return false;
      set({ busy: { ...state.busy, [id]: action }, actionErrors: clearRowError(id) });
      let ok = false;
      let code = 'unknown';
      let item: DownloadSnapshot | undefined;
      try {
        // Every per-item action resolves { ok: true, item } with the fresh snapshot.
        const res = await api[ACTION_METHODS[action]](id);
        ok = res.ok;
        if (res.ok) item = res.item;
        else code = res.code || 'unknown';
      } catch {
        // Rejected IPC call: treated as a failure with the generic message.
      }
      if (!active) return ok;
      const { [id]: _done, ...busy } = state.busy;
      void _done;
      if (!ok) {
        set({ busy, actionErrors: { ...state.actionErrors, [id]: code } });
        return false;
      }
      if (action === 'remove') {
        pending = pending.filter(p => p.item.id !== id);
        set({ busy, items: state.items.filter(i => i.id !== id) });
      } else {
        set({ busy, items: item ? mergeEvents(state.items, [{ kind: 'status', item }]) : state.items });
      }
      return true;
    },
    async showInFolder(id) {
      const reveal = api.showDownloadInFolder;
      if (!active || !reveal) return false;
      if (state.actionErrors[id]) set({ actionErrors: clearRowError(id) });
      let code = 'unknown';
      try {
        const res = await reveal.call(api, id);
        if (res.ok) return true;
        code = res.code || 'unknown';
      } catch {
        // Rejected IPC call: generic message.
      }
      if (active) set({ actionErrors: { ...state.actionErrors, [id]: code } });
      return false;
    },
    dispose,
  };
}
