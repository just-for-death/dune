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
