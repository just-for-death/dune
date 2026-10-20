import type { Game } from '@dune/shared';
import { getAchievementRoots, scanLocalAchievements } from './local.js';
import type { LocalAchievement } from './local.js';

export interface LocalAchievementImportResult {
  success: boolean;
  count: number;
  message?: string;
}

export type LocalAchievementPost = (
  game: string,
  achievements: LocalAchievement[],
) => Promise<Partial<LocalAchievementImportResult>>;

/**
 * Scan disk and hand the parsed achievements to a transport callback.
 *
 * Keeping the HTTP call injectable makes the import path testable without
 * Electron, axios, or a running Dune server.
 */
export async function importLocalAchievementsFromDisk(
  game: Game,
  post: LocalAchievementPost,
  scan: (game: Game) => LocalAchievement[] = (g) => scanLocalAchievements(getAchievementRoots(g)),
): Promise<LocalAchievementImportResult> {
  try {
    const achievements = scan(game);
    if (achievements.length === 0) {
      return { success: true, count: 0, message: 'No local achievement files found' };
    }

    const result = await post(game.name, achievements);
    return {
      success: result.success !== false,
      count: typeof result.count === 'number' ? result.count : achievements.length,
      ...(result.message ? { message: result.message } : {}),
    };
  } catch (error) {
    return {
      success: false,
      count: 0,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
