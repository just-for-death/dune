import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../i18n';
import { en } from '../../i18n/en';
import { es } from '../../i18n/es';
import {
  artworkDisabledMessage,
  isArtworkDisabled,
  nextPrivacySettings,
} from './privacyToggleHelpers';

describe('artworkDisabledMessage', () => {
  it('points to the artwork switch', () => {
    expect(artworkDisabledMessage()).toContain(en['privacy.artworkLabel']);
    expect(artworkDisabledMessage(createTranslator('es'))).toContain(es['privacy.artworkLabel'] as string);
  });

  it('asks the translator for privacy.artworkDisabled', () => {
    expect(artworkDisabledMessage((k) => k)).toBe('privacy.artworkDisabled');
    expect(artworkDisabledMessage()).toBe(en['privacy.artworkDisabled']);
  });

  it('recognises PROVIDER_DISABLED failures only (server 403 or main pre-check)', () => {
    expect(isArtworkDisabled({ ok: false, status: 403, code: 'PROVIDER_DISABLED', message: 'x' })).toBe(true);
    expect(isArtworkDisabled({ ok: false, code: 'PROVIDER_DISABLED', message: 'x' })).toBe(true);
    expect(isArtworkDisabled({ ok: false, code: 'ARTWORK_DISABLED', message: 'x' })).toBe(false);
    expect(isArtworkDisabled({ ok: false, status: 403, code: 'FORBIDDEN', message: 'x' })).toBe(false);
    expect(isArtworkDisabled({ ok: false, code: 'NETWORK' })).toBe(false);
    expect(isArtworkDisabled({ ok: true })).toBe(false);
    expect(isArtworkDisabled(null)).toBe(false);
  });
});

describe('nextPrivacySettings', () => {
  it('keeps other fields and fills missing trackers with off', () => {
    expect(nextPrivacySettings({ artworkEnabled: true }, { tracker: 'gog', enabled: true }))
      .toEqual({ artworkEnabled: true, trackersEnabled: { steam: false, retroAchievements: false, gog: true } });
    expect(nextPrivacySettings({}, { artwork: false })).toEqual({ artworkEnabled: false });
  });
});
