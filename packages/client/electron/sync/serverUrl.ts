/**
 * DUN-045: the playtime queue may only be flushed to a saved, validated Dune
 * Server URL, never to a half-typed draft.
 *
 * The renderer persists `cloud.url` on every keystroke (config:save), so the
 * main process sees "h", "ht", ... "http://192.168.1.1", "http://192.168.1.10"
 * as separate saves. Two things keep the queue away from those drafts:
 *
 *  1. `normalizeServerUrl` (@dune/shared, DUN-124: the one set of server URL
 *     rules for renderer and main) only accepts complete, absolute http(s)
 *     URLs and applies the SSRF host / port block lists.
 *  2. `createPlaytimeFlushGate` waits until the saved URL has stopped changing
 *     (settled) before treating it as the saved server URL, and flushes only
 *     when `shouldFlushPlaytime` says the settled URL is valid and new.
 *
 * Everything here is free of Electron/store/network so it can be unit tested.
 */
import { normalizeServerUrl } from '@dune/shared';

/**
 * Decide whether saving `nextUrl` should flush the playtime queue: only when
 * the next URL is valid and differs from the previously saved, normalised URL.
 * Re-saving the same URL (or an equivalent spelling of it) never re-flushes;
 * an invalid URL never flushes.
 */
export function shouldFlushPlaytime(prevSavedUrl: unknown, nextUrl: unknown): boolean {
  const next = normalizeServerUrl(nextUrl);
  if (!next) return false;
  return next !== normalizeServerUrl(prevSavedUrl);
}

/** How long the server URL must stay unchanged before it counts as saved. */
export const SERVER_URL_SETTLE_MS = 1500;

export interface PlaytimeFlushGateOptions {
  /** URL already persisted when the app starts (may be invalid/empty). */
  initialUrl?: unknown;
  /** Called with the validated URL when a newly settled URL should be flushed to. */
  flush: (url: string) => void;
  settleMs?: number;
}

export interface PlaytimeFlushGate {
  /**
   * The saved, validated server URL playtime may be posted to, or null when
   * none is saved or the user is still editing it (a change is pending).
   */
  savedUrl(): string | null;
  /** Report a `cloud.url` value the renderer just persisted. */
  onUrlSaved(rawUrl: unknown): void;
  /**
   * DUN-071/121: an explicit user action (Sync, Restore, Test) with a URL.
   * A valid URL becomes the saved URL at once (no settle wait; flushes when
   * it changed) and is returned. An invalid URL changes nothing and returns null.
   */
  commit(rawUrl: unknown): string | null;
  /** Cancel any pending settle timer. */
  dispose(): void;
}

/**
 * Turns per-keystroke `cloud.url` saves into at most one flush per real URL
 * change. Each save restarts a settle timer; when it fires, the URL becomes
 * the saved URL and the queue is flushed iff `shouldFlushPlaytime` allows it.
 * The gate never touches the queue itself, so invalid URLs can't drop items.
 */
export function createPlaytimeFlushGate(options: PlaytimeFlushGateOptions): PlaytimeFlushGate {
  const settleMs = options.settleMs ?? SERVER_URL_SETTLE_MS;
  let settled: string | null = normalizeServerUrl(options.initialUrl);
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  return {
    savedUrl: () => (timer ? null : settled),
    onUrlSaved(rawUrl: unknown) {
      const next = normalizeServerUrl(rawUrl);
      cancel();
      // Typed back to exactly the saved URL: nothing changed, nothing pending.
      if (next !== null && next === settled) return;
      timer = setTimeout(() => {
        timer = null;
        const flush = shouldFlushPlaytime(settled, next);
        settled = next;
        if (flush && next) options.flush(next);
      }, settleMs);
      (timer as { unref?: () => void }).unref?.();
    },
    commit(rawUrl: unknown) {
      const next = normalizeServerUrl(rawUrl);
      if (!next) return null;
      cancel();
      const flush = shouldFlushPlaytime(settled, next);
      settled = next;
      if (flush) options.flush(next);
      return next;
    },
    dispose: cancel,
  };
}
