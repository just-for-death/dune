import { RARITY_TIERS } from '@dune/shared';
import { getGameAchievements } from './achievements.js';
import type { AchievementDetail, AchievementRarityTier, AchievementProgress } from '@dune/shared';

const UNKNOWN_TIER = RARITY_TIERS.find((tier) => tier.tier === 'unknown') as AchievementRarityTier;
const RANGED_TIERS = RARITY_TIERS.filter((tier) => tier.tier !== 'unknown');
const COMMON_TIER = RARITY_TIERS.find((tier) => tier.tier === 'common') as AchievementRarityTier;

/** DUN-007: missing, NaN, non-numeric or <= 0 rarity is 'unknown'; > 100 clamps to common. */
export function getRarityTier(rarity: unknown): AchievementRarityTier {
  if (typeof rarity !== 'number' || Number.isNaN(rarity) || rarity <= 0) return UNKNOWN_TIER;
  return RANGED_TIERS.find((tier) => rarity >= tier.minPercent && rarity < tier.maxPercent) ?? COMMON_TIER;
}

export function getAchievementDetails(game: string, ownerId?: string): AchievementDetail[] {
  return getGameAchievements(game, ownerId).map((achievement) => ({
    id: achievement.id,
    game: achievement.game,
    apiName: achievement.apiName,
    displayName: achievement.displayName,
    description: achievement.description,
    unlocked: achievement.unlocked,
    unlockTime: achievement.unlockTime,
    rarity: achievement.rarity,
    hidden: achievement.hidden,
    isSecret: achievement.hidden,
    steamApiName: achievement.apiName,
    createdAt: achievement.createdAt,
    updatedAt: achievement.updatedAt,
  }));
}

export function getAchievementProgress(game: string, ownerId?: string): AchievementProgress {
  const details = getAchievementDetails(game, ownerId);
  const unlocked = details.filter((achievement) => achievement.unlocked);
  const rarest = unlocked
    .map((achievement) => getRarityTier(achievement.rarity))
    .filter((tier) => tier.tier !== 'unknown') // DUN-007: unknown rarity is never "rarest"
    .sort((a, b) => a.maxPercent - b.maxPercent)[0] ?? null;
  return {
    total: details.length,
    unlocked: unlocked.length,
    percentage: details.length > 0 ? Math.round((unlocked.length / details.length) * 100) : 0,
    rarestUnlocked: rarest,
  };
}
