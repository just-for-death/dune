import * as path from 'path';
import { dataDir } from '../utils/path.js';
import { readJsonFile, writeJsonFileAtomic } from '../db/jsonStore.js';
import { nextId } from '@dune/shared';

function achievementsDbPath(): string {
  return path.join(dataDir(), 'achievements.json');
}

export interface Achievement {
  id: number;
  /** Owning user id; '' = legacy/unowned (visible only to admins). */
  ownerId: string;
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
  return readJsonFile<Achievement[]>(achievementsDbPath(), [], 'achievements.json');
}

function writeAchievementsDB(achievements: Achievement[]): void {
  writeJsonFileAtomic(achievementsDbPath(), achievements);
}

/** `ownerId` undefined = all (admin view); otherwise that owner's rows only. */
function scopeByOwner(achievements: Achievement[], ownerId?: string): Achievement[] {
  if (ownerId === undefined) return achievements;
  return achievements.filter(a => (a.ownerId || '') === ownerId);
}

/** A parseable timestamp, else null (an unknown time never wins a comparison). */
function validTime(value: string | null | undefined): string | null {
  return typeof value === 'string' && value !== '' && !Number.isNaN(Date.parse(value)) ? value : null;
}

/**
 * DUN-006: an unlock is never lost. Once unlocked the row stays unlocked
 * (a locked import carries no unlock information and changes nothing), and
 * the unlock time is the EARLIEST known one: an earlier import lowers it, a
 * later or missing time never overwrites it. A locked row has no time.
 */
export function mergeUnlock(
  current: { unlocked: boolean; unlockTime: string | null },
  incoming: { unlocked: boolean; unlockTime?: string | null },
): { unlocked: boolean; unlockTime: string | null } {
  const currentTime = current.unlocked ? validTime(current.unlockTime) : null;
  if (!incoming.unlocked) return { unlocked: current.unlocked, unlockTime: currentTime };
  const incomingTime = validTime(incoming.unlockTime);
  if (currentTime === null) return { unlocked: true, unlockTime: incomingTime };
  if (incomingTime === null) return { unlocked: true, unlockTime: currentTime };
  return { unlocked: true, unlockTime: Date.parse(incomingTime) < Date.parse(currentTime) ? incomingTime : currentTime };
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
  }>,
  ownerId = ''
): { success: boolean; count: number; message?: string } {
  try {
    const db = readAchievementsDB();
    const now = new Date().toISOString();
    let count = 0;

    for (const a of achievements) {
      const existingIdx = db.findIndex(
        ach => ach.game === game && ach.apiName === a.apiName && (ach.ownerId || '') === ownerId,
      );
      
      if (existingIdx >= 0) {
        db[existingIdx] = {
          ...db[existingIdx],
          displayName: a.displayName,
          description: a.description || '',
          ...mergeUnlock(db[existingIdx], a),
          rarity: a.rarity || 0,
          hidden: a.hidden || false,
          updatedAt: now
        };
      } else {
        db.push({
          id: nextId(),
          ownerId,
          game,
          apiName: a.apiName,
          displayName: a.displayName,
          description: a.description || '',
          ...mergeUnlock({ unlocked: false, unlockTime: null }, a),
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

export function getGameAchievements(game: string, ownerId?: string): Achievement[] {
  try {
    const db = scopeByOwner(readAchievementsDB(), ownerId);
    return db
      .filter(a => a.game === game)
      .sort((a, b) => (b.unlocked ? 1 : 0) - (a.unlocked ? 1 : 0) || a.displayName.localeCompare(b.displayName));
  } catch {
    return [];
  }
}

export function getAchievementSummary(game?: string, ownerId?: string): Array<{
  game: string;
  total: number;
  unlocked: number;
  percentage: number;
}> {
  try {
    const db = scopeByOwner(readAchievementsDB(), ownerId);
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

export function getRecentUnlocks(limit = 20, ownerId?: string): Achievement[] {
  try {
    const db = scopeByOwner(readAchievementsDB(), ownerId);
    return db
      .filter(a => a.unlocked && a.unlockTime)
      .sort((a, b) => new Date(b.unlockTime!).getTime() - new Date(a.unlockTime!).getTime())
      .slice(0, limit);
  } catch {
    return [];
  }
}

