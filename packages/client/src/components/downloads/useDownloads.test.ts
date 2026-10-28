import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeApi, manualSchedule, snap, tick } from './testFixtures';

// No DOM renderer in this repo: drive the hook by hand with a minimal React shim.
const effects: (() => void | (() => void))[] = [];
let getSnapshot: (() => unknown) | null = null;
vi.mock('react', async importOriginal => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => {}],
  useEffect: (fn: () => void | (() => void)) => { effects.push(fn); },
  useSyncExternalStore: (_sub: unknown, get: () => unknown) => { getSnapshot = get; return get(); },
}));

const { useDownloads } = await import('./useDownloads');

beforeEach(() => { effects.length = 0; getSnapshot = null; });

describe('useDownloads', () => {
  it('subscribes on mount, merges progress by id once per frame, unsubscribes on unmount', async () => {
    const { api, emit, count } = fakeApi(Promise.resolve({ ok: true, items: [snap({ id: 'a' }), snap({ id: 'b', name: 'b.iso' })] }));
    const frames = manualSchedule();
    const first = useDownloads(api, frames.schedule);
    expect(first.state.phase).toBe('loading');
    expect(count()).toBe(0);

    const cleanup = effects[0]();
    expect(count()).toBe(4);
    await tick();

    emit('progress', snap({ id: 'b', name: 'b.iso', receivedBytes: 800, bytesDownloaded: 800 }));
    emit('progress', snap({ id: 'b', name: 'b.iso', receivedBytes: 900, bytesDownloaded: 900 }));
    frames.run();
    const state = getSnapshot!() as ReturnType<typeof useDownloads>['state'];
    expect(state.items.map(i => [i.id, i.receivedBytes])).toEqual([['a', 512], ['b', 900]]);

    (cleanup as () => void)();
    expect(count()).toBe(0);
  });
});
