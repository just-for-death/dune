import { describe, expect, it } from 'vitest';
import { installPathOf, savePathOf, sourceInfo } from './gameInfo';

describe('sourceInfo', () => {
  it('maps the five badge kinds', () => {
    expect(sourceInfo({ source: 'steam' })?.label).toBe('Steam');
    expect(sourceInfo({ source: 'heroic' })?.label).toBe('Heroic');
    expect(sourceInfo({ source: 'lutris' })?.label).toBe('Lutris');
    expect(sourceInfo({ source: 'manual' })?.label).toBe('Manual');
    expect(sourceInfo({ source: 'gog' })).toEqual({ kind: 'external', label: 'External', detail: 'Found by external scanner (GOG)' });
    expect(sourceInfo({ source: 'emulator' })?.kind).toBe('external');
  });

  it('returns null without a source', () => {
    expect(sourceInfo({})).toBeNull();
  });
});

describe('savePathOf / installPathOf', () => {
  it('prefers linPath, falls back to winPath, empty means none found', () => {
    expect(savePathOf({ linPath: '/home/a/saves', winPath: 'C:\\saves' })).toBe('/home/a/saves');
    expect(savePathOf({ linPath: '', winPath: 'C:\\saves' })).toBe('C:\\saves');
    expect(savePathOf({ linPath: '', winPath: '' })).toBe('');
    expect(savePathOf({ linPath: '  ', winPath: '' })).toBe('');
  });

  it('treats a missing install folder as empty', () => {
    expect(installPathOf({})).toBe('');
    expect(installPathOf({ installPath: '/games/hades' })).toBe('/games/hades');
  });
});
