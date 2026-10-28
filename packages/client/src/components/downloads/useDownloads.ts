import { useEffect, useState, useSyncExternalStore } from 'react';
import { createDownloadsStore, frameSchedule, type DownloadsState, type DownloadsStore, type Schedule } from './downloadsStore';
import type { DownloadsQueueApi } from './types';

export interface UseDownloads {
  state: DownloadsState;
  act: DownloadsStore['act'];
  reload: () => void;
  showInFolder: DownloadsStore['showInFolder'];
}

/**
 * Loads the queue, subscribes to the push events, merges progress by id and
 * renders at most once per animation frame. Unsubscribes on unmount.
 */
export function useDownloads(api: DownloadsQueueApi, schedule: Schedule = frameSchedule): UseDownloads {
  const [entry, setEntry] = useState(() => ({ api, store: createDownloadsStore(api, schedule) }));
  // A different api gets a fresh store (adjust-state-during-render, not an effect).
  if (entry.api !== api) setEntry({ api, store: createDownloadsStore(api, schedule) });
  const store = entry.store;

  useEffect(() => {
    store.start();
    return () => store.dispose();
  }, [store]);

  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  return { state, act: store.act, reload: store.reload, showInFolder: store.showInFolder };
}
