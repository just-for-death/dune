import { describe, it, expect } from 'vitest';
import { applyScannerSources, listScannerSources, sanitizeScannerSources, setScannerSource, SCANNER_SOURCE_IDS } from './sourceToggles';
import { sanitizeSettings } from '../utils';

function fakeRegistry() {
  const sources = [
    { id: 'steam', name: 'Steam', enabled: true },
    { id: 'epic', name: 'Epic Games', enabled: false },
    { id: 'emulator', name: 'Emulators', enabled: false },
    { id: 'manual', name: 'Manual Entry', enabled: true },
  ];
  return {
    sources,
    getAllSources: () => sources,
    getSource: (id: string) => sources.find((s) => s.id === id),
  };
}

describe('scanner source toggles (DUN-077)', () => {
  it('saved toggles are applied to the registry; unknown ids and non-booleans are dropped', () => {
    const reg = fakeRegistry();
    const toggles = sanitizeScannerSources({ epic: true, steam: false, manual: false, evil: true, emulator: 'yes' });
    expect(toggles).toEqual({ epic: true, steam: false });
    applyScannerSources(reg, toggles);
    expect(reg.sources.map((s) => [s.id, s.enabled])).toEqual([['steam', false], ['epic', true], ['emulator', false], ['manual', true]]);
  });

  it('setScannerSource validates, applies and returns what to save', () => {
    const reg = fakeRegistry();
    const { result, toggles } = setScannerSource(reg, { steam: true }, 'emulator', true);
    expect(toggles).toEqual({ steam: true, emulator: true });
    expect(result).toEqual({ ok: true, sources: listScannerSources(reg) });
    expect(reg.getSource('emulator')?.enabled).toBe(true);
    expect(setScannerSource(reg, {}, 'manual', false).result).toEqual({ ok: false, reason: 'unknown-source' });
    expect(setScannerSource(reg, {}, 'epic', 'true').result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('manual is never listed as a toggle; every toggle id is known', () => {
    expect(listScannerSources(fakeRegistry()).map((s) => s.id)).toEqual(['steam', 'epic', 'emulator']);
    expect(SCANNER_SOURCE_IDS).not.toContain('manual');
  });

  it('config:save cannot change the toggles; it keeps the stored value (sanitizeSettings)', () => {
    const stored = { scannerSources: { epic: true }, updateChecks: true };
    const next = sanitizeSettings({ scannerSources: { epic: false, steam: false }, updateChecks: false }, stored);
    expect(next.scannerSources).toEqual({ epic: true });
    expect(next.updateChecks).toBe(false);
    expect(next).not.toHaveProperty('steamGridDbKey');
    expect(sanitizeSettings({ steamGridDbKey: 'leak' }, {})).not.toHaveProperty('steamGridDbKey');
    expect(sanitizeSettings({}, {}).updateChecks).toBe(false);
  });
});
