import { useEffect, useState } from 'react';
import type { ElectronAPI } from '@dune/shared';

/**
 * DUN-115: what the renderer knows about the signed-in user's role.
 * 'unknown' covers loading, no server, and any failure. Callers must NOT
 * hide or disable admin controls for 'unknown': the server's 403
 * (`where.needsAdmin`, serverAdmin.ts describeFailure) is the fallback.
 */
export type AdminState = 'unknown' | 'admin' | 'member';

/** Maps a getCurrentUser() result (or a thrown error) to an AdminState. */
export function adminStateFrom(result: unknown): AdminState {
  if (result instanceof Error || !result || typeof result !== 'object') return 'unknown';
  const r = result as { ok?: unknown; role?: unknown };
  if (r.ok !== true) return 'unknown';
  if (r.role === 'admin') return 'admin';
  if (r.role === 'member') return 'member';
  return 'unknown';
}

/** Calls getCurrentUser once; never rejects. */
export async function fetchAdminState(api: Pick<ElectronAPI, 'getCurrentUser'> | undefined): Promise<AdminState> {
  if (!api || typeof api.getCurrentUser !== 'function') return 'unknown';
  try {
    return adminStateFrom(await api.getCurrentUser());
  } catch {
    return 'unknown';
  }
}

/** Server-wide writes (sources, servers, settings) are blocked only for a known member. */
export function isLockedForRole(state: AdminState): boolean {
  return state === 'member';
}

/**
 * The signed-in user's role for the current connection. Fetched once per
 * `connectionKey` (change it when the server address or key changes);
 * 'unknown' while loading, when `enabled` is false, or on any error.
 */
export function useIsAdmin(enabled: boolean, connectionKey = ''): AdminState {
  const [loaded, setLoaded] = useState<{ key: string; state: AdminState } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const api = typeof window === 'undefined' ? undefined : window.electronAPI;
    void fetchAdminState(api).then(state => {
      if (live) setLoaded({ key: connectionKey, state });
    });
    return () => { live = false; };
  }, [enabled, connectionKey]);

  return enabled && loaded?.key === connectionKey ? loaded.state : 'unknown';
}
