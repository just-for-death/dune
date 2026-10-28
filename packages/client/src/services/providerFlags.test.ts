import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchProviderFlags, flagSaveErrorKey, flagsFrom, saveProviderFlags, useProviderFlags } from './providerFlags';
import { en } from '../i18n/en';
import { es } from '../i18n/es';

/**
 * Minimal hook runner (node env, no DOM): a fake useState/useEffect/useCallback
 * so useProviderFlags runs as in React (effects re-run when deps change,
 * cleanup first; setState re-renders on settle()).
 */
const h = vi.hoisted(() => ({
  states: [] as unknown[], effects: [] as { deps: unknown[]; cleanup?: () => void }[], cbs: [] as { deps: unknown[]; fn: unknown }[],
  pending: [] as (() => void)[], si: 0, ei: 0, ci: 0, dirty: false,
}));
vi.mock('react', () => {
  const same = (a: unknown[] | undefined, b: unknown[]) => !!a && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  return {
    useState: (init: unknown) => {
      const i = h.si++;
      if (!(i in h.states)) h.states[i] = init;
      const set = (v: unknown) => { h.states[i] = typeof v === 'function' ? (v as (p: unknown) => unknown)(h.states[i]) : v; h.dirty = true; };
      return [h.states[i], set];
    },
    useCallback: (fn: unknown, deps: unknown[]) => {
      const i = h.ci++;
      if (same(h.cbs[i]?.deps, deps)) return h.cbs[i].fn;
      h.cbs[i] = { fn, deps };
      return fn;
    },
    useEffect: (fn: () => (() => void) | void, deps: unknown[]) => {
      const i = h.ei++;
      const prev = h.effects[i];
      if (same(prev?.deps, deps)) return;
      h.effects[i] = { deps };
      h.pending.push(() => { prev?.cleanup?.(); h.effects[i].cleanup = fn() || undefined; });
    },
  };
});

function mountFlags(enabled: boolean, key: string) {
  h.states = []; h.effects = []; h.cbs = []; h.pending = [];
  let args = { enabled, key };
  let result!: ReturnType<typeof useProviderFlags>;
  const render = () => {
    h.si = 0; h.ei = 0; h.ci = 0; h.dirty = false;
    // The fake React above runs the hook outside a component on purpose.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    result = useProviderFlags(args.enabled, args.key);
    const run = h.pending; h.pending = [];
    run.forEach(f => f());
  };
  render();
  return {
    get current() { return result; },
    rerender(next: { enabled: boolean; key: string }) { args = next; render(); },
    /** Lets pending fetches resolve, then re-renders while state changed. */
    async settle() {
      for (let n = 0; n < 5; n++) {
        await new Promise(r => setTimeout(r, 0));
        if (h.dirty) render();
      }
    },
    act(fn: () => void) { fn(); if (h.dirty) render(); },
  };
}

const okFlags = (hltbEnabled: boolean, artworkEnabled: boolean, manifestEnabled = false) => ({ ok: true, hltbEnabled, artworkEnabled, manifestEnabled });
const failed = { ok: false, code: 'NETWORK', message: 'x' };
afterEach(() => { vi.unstubAllGlobals(); });

describe('useProviderFlags', () => {
  it('reports a failed load, does not auto-retry, and reload() loads the flags', async () => {
    const get = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(okFlags(true, false));
    vi.stubGlobal('window', { electronAPI: { getServerProviderFlags: get } });
    const hook = mountFlags(true, 'a#1');
    expect(hook.current).toMatchObject({ flags: null, loadFailed: false, reloading: false });
    await hook.settle();
    expect(hook.current).toMatchObject({ flags: null, loadFailed: true, reloading: false });
    await hook.settle();
    expect(get).toHaveBeenCalledTimes(1);

    hook.act(() => hook.current.reload());
    expect(hook.current).toMatchObject({ flags: null, loadFailed: true, reloading: true });
    hook.act(() => hook.current.reload()); // in flight: no second request
    expect(get).toHaveBeenCalledTimes(2);

    await hook.settle();
    expect(hook.current).toMatchObject({ flags: { hltbEnabled: true, artworkEnabled: false, manifestEnabled: false }, loadFailed: false, reloading: false });
    hook.act(() => hook.current.reload()); // loaded: no-op
    await hook.settle();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('a reload that fails again keeps the note and allows another try', async () => {
    const get = vi.fn().mockResolvedValue(failed);
    vi.stubGlobal('window', { electronAPI: { getServerProviderFlags: get } });
    const hook = mountFlags(true, 'a#1');
    await hook.settle();
    hook.act(() => hook.current.reload());
    await hook.settle();
    expect(hook.current).toMatchObject({ flags: null, loadFailed: true, reloading: false });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('drops a stale reply after the connection changes', async () => {
    let resolveOld!: (v: unknown) => void;
    const get = vi.fn()
      .mockReturnValueOnce(new Promise(r => { resolveOld = r; }))
      .mockResolvedValueOnce(failed);
    vi.stubGlobal('window', { electronAPI: { getServerProviderFlags: get } });
    const hook = mountFlags(true, 'a#1');
    hook.rerender({ enabled: true, key: 'b#1' });
    await hook.settle();
    expect(hook.current).toMatchObject({ flags: null, loadFailed: true });
    resolveOld(okFlags(true, true));
    await hook.settle();
    expect(hook.current).toMatchObject({ flags: null, loadFailed: true });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('never loads or fails while disabled', async () => {
    const get = vi.fn().mockResolvedValue(failed);
    vi.stubGlobal('window', { electronAPI: { getServerProviderFlags: get } });
    const hook = mountFlags(false, '');
    await hook.settle();
    hook.act(() => hook.current.reload());
    await hook.settle();
    expect(get).not.toHaveBeenCalled();
    expect(hook.current).toMatchObject({ flags: null, loadFailed: false, reloading: false });
  });
});

describe('flagsFrom', () => {
  it('reads the flat ServerResult, including manifestEnabled', () => {
    expect(flagsFrom({ ok: true, hltbEnabled: true, artworkEnabled: false, manifestEnabled: true })).toEqual({ hltbEnabled: true, artworkEnabled: false, manifestEnabled: true });
    expect(flagsFrom({ ok: true, hltbEnabled: false, artworkEnabled: false, manifestEnabled: false })).toEqual({ hltbEnabled: false, artworkEnabled: false, manifestEnabled: false });
  });

  it('reads a missing manifestEnabled (older server) as off', () => {
    expect(flagsFrom({ ok: true, hltbEnabled: true, artworkEnabled: false })).toEqual({ hltbEnabled: true, artworkEnabled: false, manifestEnabled: false });
  });

  it('rejects failures, missing or non-boolean flags, and junk', () => {
    expect(flagsFrom({ ok: false, code: 'FORBIDDEN', message: 'x', status: 403 })).toBeNull();
    expect(flagsFrom({ ok: true, hltbEnabled: true })).toBeNull();
    expect(flagsFrom({ ok: true, hltbEnabled: 'yes', artworkEnabled: false })).toBeNull();
    expect(flagsFrom({ ok: true, hltbEnabled: true, artworkEnabled: false, manifestEnabled: 'true' })).toBeNull();
    expect(flagsFrom({ ok: true, hltbEnabled: true, artworkEnabled: false, manifestEnabled: null })).toBeNull();
    expect(flagsFrom(new Error('x'))).toBeNull();
    expect(flagsFrom(null)).toBeNull();
  });
});

describe('fetchProviderFlags', () => {
  it('returns the flags, or null without an API, on failure or on a throw', async () => {
    const ok = { getServerProviderFlags: vi.fn().mockResolvedValue({ ok: true, hltbEnabled: false, artworkEnabled: true, manifestEnabled: true }) };
    expect(await fetchProviderFlags(ok)).toEqual({ hltbEnabled: false, artworkEnabled: true, manifestEnabled: true });
    expect(ok.getServerProviderFlags).toHaveBeenCalledTimes(1);
    expect(await fetchProviderFlags(undefined)).toBeNull();
    expect(await fetchProviderFlags({ getServerProviderFlags: vi.fn().mockResolvedValue({ ok: false, code: 'NETWORK', message: 'x' }) })).toBeNull();
    expect(await fetchProviderFlags({ getServerProviderFlags: vi.fn().mockRejectedValue(new Error('boom')) })).toBeNull();
  });
});

describe('saveProviderFlags', () => {
  it('sends only the patch and returns the saved flags', async () => {
    const set = vi.fn().mockResolvedValue({ ok: true, hltbEnabled: true, artworkEnabled: false, manifestEnabled: false });
    expect(await saveProviderFlags({ setServerProviderFlags: set }, { hltbEnabled: true })).toEqual({ ok: true, flags: { hltbEnabled: true, artworkEnabled: false, manifestEnabled: false } });
    expect(set).toHaveBeenCalledWith({ hltbEnabled: true });
  });

  it('saves a manifestEnabled patch alone and returns the saved copy', async () => {
    const set = vi.fn().mockResolvedValue({ ok: true, hltbEnabled: false, artworkEnabled: false, manifestEnabled: true });
    expect(await saveProviderFlags({ setServerProviderFlags: set }, { manifestEnabled: true })).toEqual({ ok: true, flags: { hltbEnabled: false, artworkEnabled: false, manifestEnabled: true } });
    expect(set).toHaveBeenCalledWith({ manifestEnabled: true });
    const member = { setServerProviderFlags: vi.fn().mockResolvedValue({ ok: false, status: 403, code: 'FORBIDDEN', message: 'x' }) };
    expect(await saveProviderFlags(member, { manifestEnabled: true })).toEqual({ ok: false, code: 'FORBIDDEN' });
  });

  it('passes the failure code through (FORBIDDEN, INVALID_SETTINGS) and maps throws and junk', async () => {
    const fail = (code: string, status?: number) => ({ setServerProviderFlags: vi.fn().mockResolvedValue({ ok: false, code, status, message: 'x' }) });
    expect(await saveProviderFlags(fail('FORBIDDEN', 403), { artworkEnabled: true })).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(await saveProviderFlags(fail('INVALID_SETTINGS', 400), { artworkEnabled: true })).toEqual({ ok: false, code: 'INVALID_SETTINGS' });
    expect(await saveProviderFlags({ setServerProviderFlags: vi.fn().mockRejectedValue(new Error('x')) }, {})).toEqual({ ok: false, code: 'NETWORK' });
    expect(await saveProviderFlags({ setServerProviderFlags: vi.fn().mockResolvedValue({ ok: true }) }, {})).toEqual({ ok: false, code: 'UNKNOWN' });
    expect(await saveProviderFlags(undefined, {})).toEqual({ ok: false, code: 'NO_SERVER' });
  });
});

describe('flagSaveErrorKey', () => {
  it('says admin only for FORBIDDEN and is generic otherwise, in en and es', () => {
    expect(flagSaveErrorKey('FORBIDDEN')).toBe('privacy.flagSaveAdminOnly');
    for (const code of ['INVALID_SETTINGS', 'NETWORK', 'UNKNOWN', 'PROVIDER_DISABLED']) expect(flagSaveErrorKey(code)).toBe('privacy.flagSaveFailed');
    for (const key of ['privacy.flagSaveAdminOnly', 'privacy.flagSaveFailed', 'privacy.flagLoadFailed', 'privacy.hltbLocalOff', 'privacy.hltbLocalOn'] as const) {
      expect(en[key]).toBeTruthy();
      expect(es[key]).toBeTruthy();
      expect(es[key]).not.toBe(en[key]);
    }
  });
});
