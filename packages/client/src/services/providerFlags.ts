import { useCallback, useEffect, useState } from 'react';
import type { ElectronAPI } from '@dune/shared';

/**
 * Server-wide provider opt-ins (Settings.hltbEnabled / artworkEnabled on the
 * Dune server). Read by anyone; written by admins only (POST answers 403
 * FORBIDDEN for a member, 400 INVALID_SETTINGS for a bad value).
 */
export interface ProviderFlags { hltbEnabled: boolean; artworkEnabled: boolean }
export type ProviderFlagPatch = Partial<ProviderFlags>;

type FlagsApi = Pick<ElectronAPI, 'getServerProviderFlags' | 'setServerProviderFlags'>;

/** The flags from a get/set result, or null for a failure, a throw, or a malformed reply. */
export function flagsFrom(result: unknown): ProviderFlags | null {
  if (result instanceof Error || !result || typeof result !== 'object') return null;
  const r = result as { ok?: unknown; hltbEnabled?: unknown; artworkEnabled?: unknown };
  if (r.ok !== true || typeof r.hltbEnabled !== 'boolean' || typeof r.artworkEnabled !== 'boolean') return null;
  return { hltbEnabled: r.hltbEnabled, artworkEnabled: r.artworkEnabled };
}

/** Calls getServerProviderFlags once; null on any failure. Never rejects. */
export async function fetchProviderFlags(api: Partial<FlagsApi> | undefined): Promise<ProviderFlags | null> {
  if (!api || typeof api.getServerProviderFlags !== 'function') return null;
  try {
    return flagsFrom(await api.getServerProviderFlags());
  } catch {
    return null;
  }
}

export type SaveFlagsOutcome = { ok: true; flags: ProviderFlags } | { ok: false; code: string };

/** Calls setServerProviderFlags; the returned flags are the saved copy. Never rejects. */
export async function saveProviderFlags(api: Partial<FlagsApi> | undefined, patch: ProviderFlagPatch): Promise<SaveFlagsOutcome> {
  if (!api || typeof api.setServerProviderFlags !== 'function') return { ok: false, code: 'NO_SERVER' };
  try {
    const res: unknown = await api.setServerProviderFlags(patch);
    const flags = flagsFrom(res);
    if (flags) return { ok: true, flags };
    const code = res && typeof res === 'object' ? (res as { code?: unknown }).code : undefined;
    return { ok: false, code: typeof code === 'string' ? code : 'UNKNOWN' };
  } catch {
    return { ok: false, code: 'NETWORK' };
  }
}

/** i18n key for a failed save: FORBIDDEN means admin only; everything else is generic. */
export function flagSaveErrorKey(code: string): 'privacy.flagSaveAdminOnly' | 'privacy.flagSaveFailed' {
  return code === 'FORBIDDEN' ? 'privacy.flagSaveAdminOnly' : 'privacy.flagSaveFailed';
}

/**
 * The server's provider flags for the current connection, fetched once per
 * `connectionKey` (same key as useIsAdmin). `flags` is null while loading,
 * when `enabled` is false, or when the read failed. `setFlags` stores a saved
 * copy (from setServerProviderFlags) for the current key.
 */
export function useProviderFlags(enabled: boolean, connectionKey = ''): {
  flags: ProviderFlags | null;
  setFlags: (flags: ProviderFlags) => void;
} {
  const [loaded, setLoaded] = useState<{ key: string; flags: ProviderFlags | null } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const api = typeof window === 'undefined' ? undefined : window.electronAPI;
    void fetchProviderFlags(api).then(flags => {
      if (live) setLoaded({ key: connectionKey, flags });
    });
    return () => { live = false; };
  }, [enabled, connectionKey]);

  const setFlags = useCallback((flags: ProviderFlags) => setLoaded({ key: connectionKey, flags }), [connectionKey]);
  return { flags: enabled && loaded?.key === connectionKey ? loaded.flags : null, setFlags };
}
