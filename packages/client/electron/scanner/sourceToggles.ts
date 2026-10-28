import type { ScannerSourceId, ScannerSourceInfo, ScannerSourceToggles, SetScannerSourceResult } from '@dune/shared';

/**
 * DUN-077: scanner source on/off switches are saved in settings
 * (`settings.scannerSources`) and applied to the registry at startup and on
 * every change. Only main writes them (scanner:setSource); config:save keeps
 * the stored value. ROMs are scanned only when the 'emulator' source is on.
 */
/** Every toggleable scanner source ('manual' is always on). Matches shared ScannerSourceId. */
export const SCANNER_SOURCE_IDS: readonly ScannerSourceId[] = [
  'steam', 'heroic', 'lutris', 'epic', 'gog', 'ubisoft', 'ea', 'battlenet', 'xbox', 'minecraft', 'emulator',
];

export interface SourceRegistry {
  getAllSources(): { id: string; name: string; enabled: boolean }[];
  getSource(id: string): { enabled: boolean } | undefined;
}

export function isScannerSourceId(v: unknown): v is ScannerSourceId {
  return typeof v === 'string' && (SCANNER_SOURCE_IDS as readonly string[]).includes(v);
}

/** Keep only known ids with boolean values. */
export function sanitizeScannerSources(input: unknown): ScannerSourceToggles {
  const out: ScannerSourceToggles = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [id, value] of Object.entries(input as Record<string, unknown>)) {
    if (isScannerSourceId(id) && typeof value === 'boolean') out[id] = value;
  }
  return out;
}

/** Set every registry source that has a saved toggle; others keep their defaults. */
export function applyScannerSources(registry: SourceRegistry, toggles: ScannerSourceToggles): void {
  for (const id of SCANNER_SOURCE_IDS) {
    const value = toggles[id];
    const source = registry.getSource(id);
    if (source && typeof value === 'boolean') source.enabled = value;
  }
}

export function listScannerSources(registry: SourceRegistry): ScannerSourceInfo[] {
  return registry.getAllSources()
    .filter((s) => isScannerSourceId(s.id))
    .map((s) => ({ id: s.id as ScannerSourceId, name: s.name, enabled: s.enabled }));
}

/** Validate, apply and return the new toggles to save. */
export function setScannerSource(
  registry: SourceRegistry,
  saved: ScannerSourceToggles,
  id: unknown,
  enabled: unknown,
): { result: SetScannerSourceResult; toggles?: ScannerSourceToggles } {
  if (!isScannerSourceId(id) || !registry.getSource(id)) return { result: { ok: false, reason: 'unknown-source' } };
  if (typeof enabled !== 'boolean') return { result: { ok: false, reason: 'invalid' } };
  const toggles = { ...sanitizeScannerSources(saved), [id]: enabled };
  applyScannerSources(registry, toggles);
  return { result: { ok: true, sources: listScannerSources(registry) }, toggles };
}
