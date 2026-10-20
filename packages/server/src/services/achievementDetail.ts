import { RARITY_TIERS } from '@dune/shared';
import { getGameAchievements } from './achievements.js';
import type { AchievementDetail, AchievementRarityTier } from '@dune/shared';

export function getRarityTier(rarity: number): AchievementRarityTier {
  return RARITY_TIERS.find((tier) => rarity >= tier.minPercent && rarity < tier.maxPercent) ?? RARITY_TIERS[RARITY_TIERS.length - 1];
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
    localRarity: 0,
    hidden: achievement.hidden,
    iconUrl: '',
    iconGrayUrl: '',
    isSecret: achievement.hidden,
    steamApiName: achievement.apiName,
    createdAt: achievement.createdAt,
    updatedAt: achievement.updatedAt,
  }));
}

export function getAchievementProgress(game: string, ownerId?: string): { total: number; unlocked: number; percentage: number; rarestUnlocked: AchievementRarityTier | null } {
  const details = getAchievementDetails(game, ownerId);
  const unlocked = details.filter((achievement) => achievement.unlocked);
  const rarest = unlocked
    .map((achievement) => getRarityTier(achievement.rarity))
    .sort((a, b) => a.maxPercent - b.maxPercent)[0] ?? null;
  return {
    total: details.length,
    unlocked: unlocked.length,
    percentage: details.length > 0 ? Math.round((unlocked.length / details.length) * 100) : 0,
    rarestUnlocked: rarest,
  };
}
