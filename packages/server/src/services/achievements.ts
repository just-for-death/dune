import * as fs from 'fs';
import * as path from 'path';

const ACHIEVEMENTS_DB = path.join(process.cwd(), 'data', 'achievements.json');

export interface Achievement {
  id: number;
  game: string;
  apiName: string;
  displayName: string;
  description: string;
  unlocked: boolean;
  unlockTime: string | null;
  rarity: number;
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
}

function readAchievementsDB(): Achievement[] {
  if (!fs.existsSync(ACHIEVEMENTS_DB)) return [];
  try {
    return JSON.parse(fs.readFileSync(ACHIEVEMENTS_DB, 'utf-8'));
  } catch {
    return [];
  }
}

function writeAchievementsDB(achievements: Achievement[]): void {
  const tmpPath = ACHIEVEMENTS_DB + '.tmp.' + Date.now();
  fs.writeFileSync(tmpPath, JSON.stringify(achievements, null, 2));
  fs.renameSync(tmpPath, ACHIEVEMENTS_DB);
}

export function upsertAchievements(
  game: string,
  achievements: Array<{
    apiName: string;
    displayName: string;
    description?: string;
    unlocked: boolean;
    unlockTime?: string | null;
    rarity?: number;
    hidden?: boolean;
  }>
): { success: boolean; count: number; message?: string } {
  try {
    const db = readAchievementsDB();
    const now = new Date().toISOString();
    let count = 0;

    for (const a of achievements) {
      const existingIdx = db.findIndex(ach => ach.game === game && ach.apiName === a.apiName);
      
      if (existingIdx >= 0) {
        db[existingIdx] = {
          ...db[existingIdx],
          displayName: a.displayName,
          description: a.description || '',
          unlocked: a.unlocked,
          unlockTime: a.unlockTime || null,
          rarity: a.rarity || 0,
          hidden: a.hidden || false,
          updatedAt: now
        };
      } else {
        db.push({
          id: Date.now() + Math.random(),
          game,
          apiName: a.apiName,
          displayName: a.displayName,
          description: a.description || '',
          unlocked: a.unlocked,
          unlockTime: a.unlockTime || null,
          rarity: a.rarity || 0,
          hidden: a.hidden || false,
          createdAt: now,
          updatedAt: now
        });
      }
      count++;
    }

    writeAchievementsDB(db);
    return { success: true, count };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, count: 0, message };
  }
}

export function getGameAchievements(game: string): Achievement[] {
  try {
    const db = readAchievementsDB();
    return db
      .filter(a => a.game === game)
      .sort((a, b) => (b.unlocked ? 1 : 0) - (a.unlocked ? 1 : 0) || a.displayName.localeCompare(b.displayName));
  } catch {
    return [];
  }
}

export function getAchievementSummary(game?: string): Array<{
  game: string;
  total: number;
  unlocked: number;
  percentage: number;
}> {
  try {
    const db = readAchievementsDB();
    const filtered = game ? db.filter(a => a.game === game) : db;
    
    const grouped = new Map<string, { total: number; unlocked: number }>();
    
    for (const a of filtered) {
      const existing = grouped.get(a.game) || { total: 0, unlocked: 0 };
      existing.total++;
      if (a.unlocked) existing.unlocked++;
      grouped.set(a.game, existing);
    }
    
    return Array.from(grouped.entries())
      .map(([game, stats]) => ({
        game,
        total: stats.total,
        unlocked: stats.unlocked,
        percentage: stats.total > 0 ? Math.round((stats.unlocked / stats.total) * 100) : 0
      }))
      .sort((a, b) => b.unlocked - a.unlocked);
  } catch {
    return [];
  }
}

export function getRecentUnlocks(limit = 20): Achievement[] {
  try {
    const db = readAchievementsDB();
    return db
      .filter(a => a.unlocked && a.unlockTime)
      .sort((a, b) => new Date(b.unlockTime!).getTime() - new Date(a.unlockTime!).getTime())
      .slice(0, limit);
  } catch {
    return [];
  }
}

export function handleSentinelWebhook(
  game: string,
  achievements: Array<{
    apiName: string;
    displayName: string;
    description?: string;
    unlocked: boolean;
    unlockTime?: string | null;
    rarity?: number;
    hidden?: boolean;
  }>
): { success: boolean; count: number; message?: string } {
  return upsertAchievements(game, achievements);
}
