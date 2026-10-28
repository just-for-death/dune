import { describe, it, expect } from 'vitest';
import { sanitizeSettings, sanitizeTrackersEnabled } from './utils';

describe('trackers and artwork are opt-in', () => {
  it('defaults every tracker and artwork to off', () => {
    const s = sanitizeSettings({}, {});
    expect(s.trackersEnabled).toEqual({ steam: false, retroAchievements: false, gog: false });
    expect(s.artworkEnabled).toBe(false);
  });

  it('only a literal true turns one on', () => {
    expect(sanitizeTrackersEnabled({ steam: true, gog: 'true', epic: 1, extra: true })).toEqual({ steam: true, retroAchievements: false, gog: false });
    expect(sanitizeTrackersEnabled(['steam'])).toEqual({ steam: false, retroAchievements: false, gog: false });
    expect(sanitizeSettings({ artworkEnabled: 'yes' }, {}).artworkEnabled).toBe(false);
    expect(sanitizeSettings({ artworkEnabled: true, trackersEnabled: { retroAchievements: true } }, {})).toMatchObject({ artworkEnabled: true, trackersEnabled: { retroAchievements: true, steam: false } });
  });
});

describe('HowLongToBeat is opt-in (Settings.hltbEnabled)', () => {
  it('defaults to off and keeps a literal true', () => {
    expect(sanitizeSettings({}, {}).hltbEnabled).toBe(false);
    expect(sanitizeSettings({ hltbEnabled: true }, {}).hltbEnabled).toBe(true);
  });

  it('only a literal true turns it on (no fallback to the stored value)', () => {
    for (const v of ['true', 1, 'yes', null, undefined, {}, [true]]) {
      expect(sanitizeSettings({ hltbEnabled: v }, { hltbEnabled: true }).hltbEnabled).toBe(false);
    }
  });

  it('is kept alongside the other opt-ins', () => {
    const s = sanitizeSettings({ hltbEnabled: true, artworkEnabled: true, updateCheckEnabled: true, manifestEnabled: true }, {});
    expect(s).toMatchObject({ hltbEnabled: true, artworkEnabled: true, updateCheckEnabled: true, manifestEnabled: true });
  });
});

describe.each(['manifestEnabled', 'updateCheckEnabled'] as const)('%s is opt-in', (key) => {
  it('defaults to off and keeps a literal true', () => {
    expect(sanitizeSettings({}, {})[key]).toBe(false);
    expect(sanitizeSettings({ [key]: true }, {})[key]).toBe(true);
    expect(sanitizeSettings({ [key]: false }, { [key]: true })[key]).toBe(false);
  });

  it('only a literal true turns it on (no fallback to the stored value)', () => {
    for (const v of ['true', 1, 'yes', null, undefined, {}, [true]]) {
      expect(sanitizeSettings({ [key]: v }, { [key]: true })[key]).toBe(false);
    }
  });
});

describe('the legacy update flag is gone (no shim)', () => {
  it('a stored or sent legacy key neither enables nor survives', () => {
    const legacy = 'update' + 'Checks';
    const s = sanitizeSettings({ [legacy]: true }, { [legacy]: true });
    expect(s.updateCheckEnabled).toBe(false);
    expect(s).not.toHaveProperty(legacy);
  });
});
