import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { upsertAchievements, getGameAchievements, getAchievementSummary, getRecentUnlocks, handleSentinelWebhook } from './achievements.js';

const ACHIEVEMENTS_DB = path.join(process.cwd(), 'data', 'achievements.json');

beforeEach(() => {
  if (fs.existsSync(ACHIEVEMENTS_DB)) fs.rmSync(ACHIEVEMENTS_DB);
});

afterEach(() => {
  if (fs.existsSync(ACHIEVEMENTS_DB)) fs.rmSync(ACHIEVEMENTS_DB);
});

describe('upsertAchievements', () => {
  it('should insert new achievements', () => {
    const result = upsertAchievements('Test Game', [
      { apiName: 'ACH_001', displayName: 'First Achievement', description: 'Description', unlocked: true, unlockTime: '2024-01-01T10:00:00.000Z', rarity: 50, hidden: false },
      { apiName: 'ACH_002', displayName: 'Second Achievement', description: 'Description 2', unlocked: false, rarity: 10, hidden: true }
    ]);
    
    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
  });

  it('should update existing achievements', () => {
    upsertAchievements('Test Game', [
      { apiName: 'ACH_001', displayName: 'First', description: 'Desc', unlocked: false, rarity: 50 }
    ]);
    
    const result = upsertAchievements('Test Game', [
      { apiName: 'ACH_001', displayName: 'First Updated', description: 'New Desc', unlocked: true, unlockTime: '2024-01-01T10:00:00.000Z', rarity: 60 }
    ]);
    
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    
    const achievements = getGameAchievements('Test Game');
    expect(achievements.length).toBe(1);
    expect(achievements[0].displayName).toBe('First Updated');
    expect(achievements[0].unlocked).toBe(true);
    expect(achievements[0].rarity).toBe(60);
  });

  it('should handle optional fields', () => {
    const result = upsertAchievements('Test Game', [
      { apiName: 'ACH_001', displayName: 'Minimal', unlocked: true }
    ]);
    
    expect(result.success).toBe(true);
    const achievements = getGameAchievements('Test Game');
    expect(achievements[0].description).toBe('');
    expect(achievements[0].rarity).toBe(0);
    expect(achievements[0].hidden).toBe(false);
    expect(achievements[0].unlockTime).toBeNull();
  });
});

describe('getGameAchievements', () => {
  it('should return empty array for unknown game', () => {
    const achievements = getGameAchievements('Unknown Game');
    expect(achievements).toEqual([]);
  });

  it('should sort by unlocked desc then name asc', () => {
    upsertAchievements('Test Game', [
      { apiName: 'B_ACH', displayName: 'B Achievement', unlocked: true },
      { apiName: 'A_ACH', displayName: 'A Achievement', unlocked: true },
      { apiName: 'C_ACH', displayName: 'C Achievement', unlocked: false }
    ]);
    
    const achievements = getGameAchievements('Test Game');
    expect(achievements[0].displayName).toBe('A Achievement');
    expect(achievements[1].displayName).toBe('B Achievement');
    expect(achievements[2].displayName).toBe('C Achievement');
  });
});

describe('getAchievementSummary', () => {
  it('should return empty array for no achievements', () => {
    const summary = getAchievementSummary();
    expect(summary).toEqual([]);
  });

  it('should calculate percentage correctly', () => {
    upsertAchievements('Game A', [
      { apiName: 'ACH_1', displayName: 'One', unlocked: true },
      { apiName: 'ACH_2', displayName: 'Two', unlocked: true },
      { apiName: 'ACH_3', displayName: 'Three', unlocked: false }
    ]);
    
    upsertAchievements('Game B', [
      { apiName: 'ACH_1', displayName: 'One', unlocked: true },
      { apiName: 'ACH_2', displayName: 'Two', unlocked: false }
    ]);
    
    const summary = getAchievementSummary();
    expect(summary.length).toBe(2);
    
    const gameA = summary.find(s => s.game === 'Game A');
    const gameB = summary.find(s => s.game === 'Game B');
    
    expect(gameA?.total).toBe(3);
    expect(gameA?.unlocked).toBe(2);
    expect(gameA?.percentage).toBe(67); // 2/3 * 100 = 66.66... rounded
    
    expect(gameB?.total).toBe(2);
    expect(gameB?.unlocked).toBe(1);
    expect(gameB?.percentage).toBe(50);
  });

  it('should filter by game when specified', () => {
    upsertAchievements('Game A', [{ apiName: 'ACH_1', displayName: 'One', unlocked: true }]);
    upsertAchievements('Game B', [{ apiName: 'ACH_1', displayName: 'One', unlocked: false }]);
    
    const summary = getAchievementSummary('Game A');
    expect(summary.length).toBe(1);
    expect(summary[0].game).toBe('Game A');
  });

  it('should sort by unlocked desc', () => {
    upsertAchievements('Game A', [{ apiName: 'ACH_1', displayName: 'One', unlocked: false }]);
    upsertAchievements('Game B', [{ apiName: 'ACH_1', displayName: 'One', unlocked: true }]);
    
    const summary = getAchievementSummary();
    expect(summary[0].game).toBe('Game B');
    expect(summary[1].game).toBe('Game A');
  });
});

describe('getRecentUnlocks', () => {
  it('should return only unlocked achievements with unlockTime', () => {
    upsertAchievements('Test Game', [
      { apiName: 'ACH_1', displayName: 'One', unlocked: true, unlockTime: '2024-01-01T10:00:00.000Z' },
      { apiName: 'ACH_2', displayName: 'Two', unlocked: false, unlockTime: '2024-01-01T11:00:00.000Z' },
      { apiName: 'ACH_3', displayName: 'Three', unlocked: true, unlockTime: null }
    ]);
    
    const unlocks = getRecentUnlocks();
    expect(unlocks.length).toBe(1);
    expect(unlocks[0].apiName).toBe('ACH_1');
  });

  it('should sort by unlockTime descending', () => {
    upsertAchievements('Test Game', [
      { apiName: 'ACH_1', displayName: 'One', unlocked: true, unlockTime: '2024-01-01T10:00:00.000Z' },
      { apiName: 'ACH_2', displayName: 'Two', unlocked: true, unlockTime: '2024-01-03T10:00:00.000Z' },
      { apiName: 'ACH_3', displayName: 'Three', unlocked: true, unlockTime: '2024-01-02T10:00:00.000Z' }
    ]);
    
    const unlocks = getRecentUnlocks();
    expect(unlocks[0].apiName).toBe('ACH_2');
    expect(unlocks[1].apiName).toBe('ACH_3');
    expect(unlocks[2].apiName).toBe('ACH_1');
  });

  it('should respect limit', () => {
    for (let i = 0; i < 5; i++) {
      upsertAchievements('Test Game', [{
        apiName: `ACH_${i}`,
        displayName: `Achievement ${i}`,
        unlocked: true,
        unlockTime: `2024-01-${String(i+1).padStart(2,'0')}T10:00:00.000Z`
      }]);
    }
    
    const unlocks = getRecentUnlocks(3);
    expect(unlocks.length).toBe(3);
  });
});

describe('handleSentinelWebhook', () => {
  it('should upsert achievements from Sentinel', () => {
    const result = handleSentinelWebhook('Test Game', [
      { apiName: 'ACH_001', displayName: 'First', unlocked: true, unlockTime: '2024-01-01T10:00:00.000Z' }
    ]);
    
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    
    const achievements = getGameAchievements('Test Game');
    expect(achievements[0].apiName).toBe('ACH_001');
    expect(achievements[0].unlocked).toBe(true);
  });
});
