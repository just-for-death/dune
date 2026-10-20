import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-achdetail-test-'));
process.env.DATA_DIR = TMP;

const { upsertAchievements } = await import('./achievements.js');
const { getAchievementDetails, getAchievementProgress, getRarityTier } = await import('./achievementDetail.js');

afterAll(() => {
  delete process.env.DATA_DIR;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('achievement detail', () => {
  beforeEach(() => {
    const file = path.join(TMP, 'achievements.json');
    if (fs.existsSync(file)) fs.rmSync(file);
  });

  it('maps achievements to detail with rarity tiers', () => {
    upsertAchievements('Game', [
      { apiName: 'a', displayName: 'A', description: 'desc', unlocked: true, rarity: 5, hidden: false },
      { apiName: 'b', displayName: 'B', description: 'desc2', unlocked: false, rarity: 90, hidden: true },
    ]);
    const details = getAchievementDetails('Game');
    expect(details).toHaveLength(2);
    expect(details[0].isSecret).toBe(false);
    expect(getRarityTier(5).tier).toBe('legendary');
    expect(getRarityTier(90).tier).toBe('uncommon');
  });

  it('calculates progress', () => {
    upsertAchievements('Game2', [
      { apiName: 'a', displayName: 'A', unlocked: true, rarity: 5 },
      { apiName: 'b', displayName: 'B', unlocked: false, rarity: 90 },
    ]);
    const progress = getAchievementProgress('Game2');
    expect(progress.total).toBe(2);
    expect(progress.unlocked).toBe(1);
    expect(progress.percentage).toBe(50);
    expect(progress.rarestUnlocked?.tier).toBe('legendary');
  });
});
