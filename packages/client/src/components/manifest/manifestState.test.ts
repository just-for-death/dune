import { describe, expect, it, vi } from 'vitest';
import { confirmPending, initialSuggestionsState, suggestionsReducer, type SuggestionsAction, type SuggestionsState } from './manifestState';
import type { ManifestOutcome } from './manifestFormat';

const A = '/home/u/.local/share/Game/save';
const B = '/home/u/.config/Game';
const outcome: ManifestOutcome = {
  kind: 'result', stale: false, attribution: 'a', pageUrl: null,
  suggestions: [{ path: A, kind: 'save', exists: true }, { path: B, kind: 'config', exists: false }],
};
const loaded = (): SuggestionsState => {
  let s = suggestionsReducer(initialSuggestionsState('g1'), { type: 'start', gameId: 'g1', seq: 1 });
  s = suggestionsReducer(s, { type: 'done', seq: 1, outcome });
  return s;
};
/** A dispatch that runs the reducer, so confirmPending can be driven like the component does. */
function store(initial: SuggestionsState) {
  let state = initial;
  const dispatch = (a: SuggestionsAction) => { state = suggestionsReducer(state, a); };
  return { dispatch, get: () => state };
}

describe('suggestionsReducer', () => {
  it('start clears the old result and sets loading; stale replies are ignored', () => {
    const s = suggestionsReducer(loaded(), { type: 'start', gameId: 'g1', seq: 2 });
    expect(s).toMatchObject({ loading: true, outcome: null, seq: 2, pending: null });
    expect(suggestionsReducer(s, { type: 'done', seq: 1, outcome })).toBe(s);
    expect(suggestionsReducer(s, { type: 'done', seq: 2, outcome })).toMatchObject({ loading: false, outcome });
  });

  it('request sets pending only for a listed, non-current path', () => {
    const s = loaded();
    expect(suggestionsReducer(s, { type: 'request', path: A }).pending).toBe(A);
    expect(suggestionsReducer(s, { type: 'request', path: A, current: `${A}/` }).pending).toBeNull();
    expect(suggestionsReducer(s, { type: 'request', path: '/not/listed' }).pending).toBeNull();
    expect(suggestionsReducer(initialSuggestionsState('g1'), { type: 'request', path: A }).pending).toBeNull();
  });

  it('cancel clears pending', () => {
    const s = suggestionsReducer(loaded(), { type: 'request', path: B });
    expect(suggestionsReducer(s, { type: 'cancel' }).pending).toBeNull();
  });
});

describe('confirm flow', () => {
  it('Cancel never applies', async () => {
    const st = store(loaded());
    st.dispatch({ type: 'request', path: A });
    st.dispatch({ type: 'cancel' });
    const onApply = vi.fn();
    await confirmPending(st.get(), st.dispatch, onApply);
    expect(onApply).not.toHaveBeenCalled();
    expect(st.get()).toMatchObject({ pending: null, applying: null, applyResult: null });
  });

  it('nothing is applied without a request first', async () => {
    const st = store(loaded());
    const onApply = vi.fn();
    await confirmPending(st.get(), st.dispatch, onApply);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('Confirm calls onApply once with the exact path, then reports applied', async () => {
    const weird = 'C:\\Users\\u\\Saved Games\\<script>alert(1)</script> ünï/';
    const s0 = { ...loaded(), outcome: { ...outcome, suggestions: [{ path: weird, kind: 'save' as const, exists: false }] } };
    const st2 = store(s0);
    st2.dispatch({ type: 'request', path: weird });
    let resolve!: () => void;
    const onApply = vi.fn(() => new Promise<void>(r => { resolve = r; }));
    const running = confirmPending(st2.get(), st2.dispatch, onApply);
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith(weird);
    expect(st2.get()).toMatchObject({ pending: null, applying: weird });
    resolve();
    await running;
    expect(st2.get()).toMatchObject({ applying: null, applyResult: { kind: 'applied', path: weird } });
  });

  it('a rejected onApply reports failed; a sync onApply works', async () => {
    const st = store(loaded());
    st.dispatch({ type: 'request', path: B });
    await confirmPending(st.get(), st.dispatch, () => { throw new Error('nope'); });
    expect(st.get().applyResult).toEqual({ kind: 'failed', path: B });
    st.dispatch({ type: 'request', path: A });
    const sync = vi.fn();
    await confirmPending(st.get(), st.dispatch, sync);
    expect(sync).toHaveBeenCalledWith(A);
    expect(st.get().applyResult).toEqual({ kind: 'applied', path: A });
  });
});
