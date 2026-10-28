import { describe, expect, it } from 'vitest';
import { canShowInFolder, createDownloadsStore, mergeEvents } from './downloadsStore';
import { fakeApi, manualSchedule, snap, tick } from './testFixtures';

describe('mergeEvents', () => {
  it('merges progress by id, ignores progress for unknown ids, inserts on status', () => {
    const items = [snap({ id: 'a' }), snap({ id: 'b', name: 'b.zip' })];
    const out = mergeEvents(items, [
      { kind: 'progress', item: snap({ id: 'a', receivedBytes: 900, bytesDownloaded: 900 }) },
      { kind: 'progress', item: snap({ id: 'zzz' }) },
      { kind: 'status', item: snap({ id: 'c', status: 'queued' }) },
    ]);
    expect(out.map(i => i.id)).toEqual(['a', 'b', 'c']);
    expect(out[0].receivedBytes).toBe(900);
    expect(out[1]).toBe(items[1]);
  });

  it('keeps a newer snapshot over a stale one', () => {
    const items = [snap({ id: 'a', status: 'completed', updatedAt: '2026-10-28T10:05:00.000Z' })];
    const out = mergeEvents(items, [{ kind: 'progress', item: snap({ id: 'a', status: 'downloading', updatedAt: '2026-10-28T10:01:00.000Z' }) }]);
    expect(out[0].status).toBe('completed');
  });
});

describe('createDownloadsStore', () => {
  it('loads the list, then coalesces bursts into one update per frame', async () => {
    const { api, emit } = fakeApi(Promise.resolve({ ok: true, items: [snap()] }));
    const frames = manualSchedule();
    const store = createDownloadsStore(api, frames.schedule);
    let renders = 0;
    store.subscribe(() => { renders++; });
    store.start();
    await tick();
    expect(store.getState().phase).toBe('ready');
    renders = 0;
    for (let n = 1; n <= 20; n++) emit('progress', snap({ receivedBytes: 512 + n, bytesDownloaded: 512 + n }));
    expect(renders).toBe(0);
    expect(frames.pending()).toBe(1);
    frames.run();
    expect(renders).toBe(1);
    expect(store.getState().items[0].receivedBytes).toBe(532);
    expect(store.getState().announcement).toBeNull();
  });

  it('buffers events that arrive before list() resolves and replays them on top', async () => {
    let resolve!: (v: { ok: true; items: ReturnType<typeof snap>[] }) => void;
    const { api, emit } = fakeApi(new Promise(r => { resolve = r; }));
    const frames = manualSchedule();
    const store = createDownloadsStore(api, frames.schedule);
    store.start();
    emit('status', snap({ id: 'a', status: 'paused', updatedAt: '2026-10-28T10:02:00.000Z' }));
    resolve({ ok: true, items: [snap({ id: 'a' })] });
    await tick();
    frames.run();
    expect(store.getState().items[0].status).toBe('paused');
  });

  it('announces completions and failures only', async () => {
    const { api, emit } = fakeApi(Promise.resolve({ ok: true, items: [snap()] }));
    const frames = manualSchedule();
    const store = createDownloadsStore(api, frames.schedule);
    store.start();
    await tick();
    emit('progress', snap({ receivedBytes: 1000 }));
    frames.run();
    expect(store.getState().announcement).toBeNull();
    emit('completed', snap({ status: 'completed', receivedBytes: 1024, updatedAt: '2026-10-28T10:09:00.000Z' }));
    frames.run();
    expect(store.getState().announcement).toMatchObject({ kind: 'completed', name: 'game.zip', seq: 1 });
    emit('failed', snap({ id: 'a', status: 'failed', errorCode: 'IO_ERROR', updatedAt: '2026-10-28T10:10:00.000Z' }));
    frames.run();
    expect(store.getState().announcement).toMatchObject({ kind: 'failed', code: 'IO_ERROR', seq: 2 });
    // The failed event's own `error` wins over the snapshot.
    emit('failed', snap({ status: 'failed', errorCode: null, updatedAt: '2026-10-28T10:11:00.000Z' }), { ok: false, code: 'TIMEOUT', message: '' });
    frames.run();
    expect(store.getState().announcement).toMatchObject({ kind: 'failed', code: 'TIMEOUT', seq: 3 });
  });

  it('ignores malformed event payloads (no { item })', async () => {
    const { api } = fakeApi(Promise.resolve({ ok: true, items: [snap()] }));
    let push!: (e: unknown) => void;
    api.onDownloadStatus = cb => { push = cb as (e: unknown) => void; return () => {}; };
    const frames = manualSchedule();
    const store = createDownloadsStore(api, frames.schedule);
    store.start();
    await tick();
    push(snap({ id: 'raw' }));
    push(undefined);
    frames.run();
    expect(store.getState().items.map(i => i.id)).toEqual(['a']);
  });

  it('updates the row from the { ok: true, item } action result', async () => {
    const { api } = fakeApi(Promise.resolve({ ok: true, items: [snap({ id: 'a' })] }));
    const calls: string[] = [];
    api.pauseDownload = async id => { calls.push(id); return { ok: true, item: snap({ id, status: 'paused', speed: 0, updatedAt: '2026-10-28T10:03:00.000Z' }) }; };
    const store = createDownloadsStore(api, manualSchedule().schedule);
    store.start();
    await tick();
    expect(await store.act('a', 'pause')).toBe(true);
    expect(calls).toEqual(['a']);
    expect(store.getState().items[0]).toMatchObject({ id: 'a', status: 'paused', speed: 0 });
    store.dispose();
  });

  it('unsubscribes every event and drops late events and a pending frame on dispose', async () => {
    const { api, emit, count } = fakeApi(Promise.resolve({ ok: true, items: [snap()] }));
    const frames = manualSchedule();
    const store = createDownloadsStore(api, frames.schedule);
    store.start();
    expect(count()).toBe(4);
    await tick();
    emit('progress', snap({ receivedBytes: 700 }));
    store.dispose();
    expect(count()).toBe(0);
    expect(frames.pending()).toBe(0);
    emit('progress', snap({ receivedBytes: 800 }));
    frames.run();
    expect(store.getState().items[0].receivedBytes).toBe(512);
    store.start();
    expect(count()).toBe(4);
    store.dispose();
  });

  it('records action errors per row and drops a removed item locally', async () => {
    const { api } = fakeApi(Promise.resolve({ ok: true, items: [snap({ id: 'a' }), snap({ id: 'b', status: 'completed' })] }));
    api.pauseDownload = async () => ({ ok: false, code: 'INVALID_STATE', message: 'nope' });
    const store = createDownloadsStore(api, manualSchedule().schedule);
    store.start();
    await tick();
    expect(await store.act('a', 'pause')).toBe(false);
    expect(store.getState().actionErrors).toEqual({ a: 'INVALID_STATE' });
    expect(store.getState().busy).toEqual({});
    expect(await store.act('b', 'remove')).toBe(true);
    expect(store.getState().items.map(i => i.id)).toEqual(['a']);
  });

  it('shows a load error and recovers on reload', async () => {
    const { api } = fakeApi(Promise.resolve({ ok: false, code: 'IO_ERROR', message: 'x' }));
    const store = createDownloadsStore(api, manualSchedule().schedule);
    store.start();
    await tick();
    expect(store.getState()).toMatchObject({ phase: 'error', loadError: 'IO_ERROR' });
    api.listDownloads = async () => ({ ok: true, items: [] });
    store.reload();
    await tick();
    expect(store.getState().phase).toBe('ready');
    store.dispose();
  });

  it('calls showDownloadInFolder(id) directly and records its failure on the row', async () => {
    const { api } = fakeApi(Promise.resolve({ ok: true, items: [snap({ id: 'a' })] }));
    const store = createDownloadsStore(api, manualSchedule().schedule);
    store.start();
    await tick();
    expect(canShowInFolder(api)).toBe(false);
    expect(await store.showInFolder('a')).toBe(false);
    expect(store.getState().actionErrors).toEqual({});

    const ids: string[] = [];
    let result: { ok: true } | { ok: false; code: 'NOT_FOUND'; message: string } = { ok: false, code: 'NOT_FOUND', message: 'gone' };
    api.showDownloadInFolder = async id => { ids.push(id); return result; };
    expect(canShowInFolder(api)).toBe(true);
    expect(await store.showInFolder('a')).toBe(false);
    expect(store.getState().actionErrors).toEqual({ a: 'NOT_FOUND' });
    result = { ok: true };
    expect(await store.showInFolder('a')).toBe(true);
    expect(store.getState().actionErrors).toEqual({});
    expect(ids).toEqual(['a', 'a']);
    store.dispose();
  });
});
