import { DEFAULT_TRACKERS_ENABLED, type Settings, type TrackersEnabled } from '@dune/shared';
import { defaultTranslator, type Translator } from '../../i18n';
import { isProviderDisabled } from '../../services/hltbStatus';

/**
 * DUN-135 privacy helpers for PrivacyToggles.tsx (kept apart so the .tsx
 * exports only components, for React fast refresh). Text is in i18n `privacy.*`.
 */

export type TrackerId = keyof TrackersEnabled;
export const TRACKER_IDS: readonly TrackerId[] = ['steam', 'retroAchievements', 'gog'];

/** Service names are brand names, the same in every language. */
export const TRACKER_NAMES: Readonly<Record<TrackerId, string>> = {
  steam: 'Steam',
  retroAchievements: 'RetroAchievements',
  gog: 'GOG',
};

export type PrivacySettings = Pick<Settings, 'trackersEnabled' | 'artworkEnabled'>;

/**
 * True when an artwork call (game:fetchArt, art:search, art:auto-match) says
 * artwork is turned off: the server's 403 `{ code: 'PROVIDER_DISABLED' }` or
 * main's local pre-check with the same code. Same check as HLTB (services/hltbStatus).
 */
export function isArtworkDisabled(res: unknown): boolean {
  return isProviderDisabled(res);
}

/** Readable message for PROVIDER_DISABLED on artwork that points to the artwork switch (English without a translator). */
export function artworkDisabledMessage(t: Translator = defaultTranslator): string {
  return t('privacy.artworkDisabled');
}

/** The settings after one switch changes; other fields are kept as they are. */
export function nextPrivacySettings<T extends PrivacySettings>(
  settings: T,
  change: { tracker: TrackerId; enabled: boolean } | { artwork: boolean },
): T {
  if ('artwork' in change) return { ...settings, artworkEnabled: change.artwork };
  return {
    ...settings,
    trackersEnabled: { ...DEFAULT_TRACKERS_ENABLED, ...settings.trackersEnabled, [change.tracker]: change.enabled },
  };
}
