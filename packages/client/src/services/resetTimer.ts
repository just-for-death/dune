/**
 * One pending timeout at a time (DUN-050). Scheduling again replaces the
 * pending callback; clear() cancels it. Holders keep one instance in a ref and
 * clear it when a new run starts and on unmount, so a stale timer never
 * hides a newer state.
 */
export interface ResetTimer {
  schedule: (fn: () => void, ms: number) => void;
  clear: () => void;
  isPending: () => boolean;
}

export interface TimerApi {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const defaultTimers: TimerApi = {
  set: (fn, ms) => globalThis.setTimeout(fn, ms),
  clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createResetTimer(timers: TimerApi = defaultTimers): ResetTimer {
  let handle: unknown = null;
  const clear = () => {
    if (handle !== null) timers.clear(handle);
    handle = null;
  };
  return {
    schedule(fn, ms) {
      clear();
      handle = timers.set(() => {
        handle = null;
        fn();
      }, ms);
    },
    clear,
    isPending: () => handle !== null,
  };
}
