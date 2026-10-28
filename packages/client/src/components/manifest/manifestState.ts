import { isSamePath, type ManifestOutcome } from './manifestFormat';

/**
 * State for SavePathSuggestions (used with useReducer). Kept pure so the
 * confirm-before-apply rule is testable without a DOM: a path is applied only
 * from `pending`, which only a "Use this path" click sets and Cancel clears.
 */

export type ApplyResult = { kind: 'applied' | 'failed'; path: string };

export interface SuggestionsState {
  gameId: string;
  /** Increments per lookup; replies from an older lookup are ignored. */
  seq: number;
  loading: boolean;
  outcome: ManifestOutcome | null;
  /** Path waiting for the user's confirmation. */
  pending: string | null;
  /** Path being applied (onApply running). */
  applying: string | null;
  applyResult: ApplyResult | null;
}

export type SuggestionsAction =
  | { type: 'start'; gameId: string; seq: number }
  | { type: 'done'; seq: number; outcome: ManifestOutcome }
  | { type: 'request'; path: string; current?: string | null }
  | { type: 'cancel' }
  | { type: 'applyStart' }
  | { type: 'applyDone'; path: string; ok: boolean };

export function initialSuggestionsState(gameId: string): SuggestionsState {
  return { gameId, seq: 0, loading: false, outcome: null, pending: null, applying: null, applyResult: null };
}

export function suggestionsReducer(state: SuggestionsState, action: SuggestionsAction): SuggestionsState {
  switch (action.type) {
    case 'start':
      return { ...initialSuggestionsState(action.gameId), seq: action.seq, loading: true };
    case 'done':
      if (action.seq !== state.seq || !state.loading) return state;
      return { ...state, loading: false, outcome: action.outcome };
    case 'request': {
      if (state.loading || state.applying !== null || state.outcome?.kind !== 'result') return state;
      if (!state.outcome.suggestions.some(s => s.path === action.path)) return state;
      if (isSamePath(action.path, action.current)) return state;
      return { ...state, pending: action.path, applyResult: null };
    }
    case 'cancel':
      return state.pending === null ? state : { ...state, pending: null };
    case 'applyStart':
      if (state.pending === null || state.applying !== null) return state;
      return { ...state, applying: state.pending, pending: null, applyResult: null };
    case 'applyDone':
      if (state.applying !== action.path) return state;
      return { ...state, applying: null, applyResult: { kind: action.ok ? 'applied' : 'failed', path: action.path } };
    default:
      return state;
  }
}

/**
 * The Confirm step: applies exactly the pending path (if any) via onApply and
 * records the result. Does nothing when nothing is pending, so onApply can
 * only run after a "Use this path" click followed by Confirm.
 */
export async function confirmPending(
  state: SuggestionsState,
  dispatch: (action: SuggestionsAction) => void,
  onApply: (path: string) => Promise<void> | void,
  isLive: () => boolean = () => true,
): Promise<void> {
  const path = state.pending;
  if (path === null || state.applying !== null) return;
  dispatch({ type: 'applyStart' });
  let ok = true;
  try {
    await onApply(path);
  } catch {
    ok = false;
  }
  if (isLive()) dispatch({ type: 'applyDone', path, ok });
}
