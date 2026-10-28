/** Display labels for enum-like values that come from shared data. */
import type { AchievementRarityTier, Game } from '@dune/shared';
import type { MessageKey, Translator } from './index';

const GAME_STATUS_KEYS: Record<Game['status'], MessageKey> = {
  'In Sync': 'game.status.inSync',
  'Pending Upload': 'game.status.pending',
  Error: 'game.status.error',
};

/** Unknown statuses (newer main process) show as sent rather than disappearing. */
export function gameStatusLabel(status: string, t: Translator): string {
  return Object.prototype.hasOwnProperty.call(GAME_STATUS_KEYS, status)
    ? t(GAME_STATUS_KEYS[status as Game['status']])
    : status;
}

const RARITY_KEYS: Record<string, MessageKey> = {
  legendary: 'rarity.legendary',
  epic: 'rarity.epic',
  'ultra-rare': 'rarity.ultraRare',
  rare: 'rarity.rare',
  uncommon: 'rarity.uncommon',
  common: 'rarity.common',
};

export function rarityLabel(tier: Pick<AchievementRarityTier, 'tier' | 'label'>, t: Translator): string {
  return Object.prototype.hasOwnProperty.call(RARITY_KEYS, tier.tier) ? t(RARITY_KEYS[tier.tier]) : tier.label;
}
