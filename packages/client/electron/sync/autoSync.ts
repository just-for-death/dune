import type { AutoSyncEvent, CloudSyncResult } from '@dune/shared';
import { toServerFailure } from '../net/serverError';

/**
 * DUN-070: one background auto-sync run. The result is never dropped:
 * failures (each per-game / per-file item) go to the error log, and every
 * finished run is sent to the renderer as a `sync:auto` event. A run that
 * finds a sync already in progress is skipped quietly.
 */
export interface AutoSyncDeps {
  sync: () => Promise<CloudSyncResult>;
  /** A saved, gated server URL exists. */
  hasServer: () => boolean;
  appendErrorLog: (source: string, payload: Record<string, unknown>) => void;
  send: (event: AutoSyncEvent) => void;
  now?: () => Date;
}

export async function runAutoSync(deps: AutoSyncDeps): Promise<CloudSyncResult | null> {
  if (!deps.hasServer()) return null;
  let result: CloudSyncResult;
  try {
    result = await deps.sync();
  } catch (err) {
    result = toServerFailure(err);
  }
  if (!result.ok && result.code === 'SYNC_IN_PROGRESS') return result;
  if (!result.ok) {
    const items = 'failures' in result && result.failures?.length ? result.failures : [{ game: '', code: result.code, message: result.message }];
    for (const item of items) appendSafe(deps, { ...item });
  }
  try {
    deps.send({ at: (deps.now ?? (() => new Date()))().toISOString(), result });
  } catch { /* window gone */ }
  return result;
}

function appendSafe(deps: AutoSyncDeps, payload: Record<string, unknown>): void {
  try { deps.appendErrorLog('auto-sync', payload); } catch { /* logging must never throw */ }
}
