import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-achdetail-test-'));
const SETUP_DATA_DIR = process.env.DATA_DIR as string; // temp dir from src/test/setup.ts (DUN-005)
process.env.DATA_DIR = TMP;

const { upsertAchievements } = await import('./achievements.js');
const { getAchievementDetails, getAchievementProgress, getRarityTier } = await import('./achievementDetail.js');

afterAll(() => {
  process.env.DATA_DIR = SETUP_DATA_DIR; // restore the temp dir, never unset (DUN-005)
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

  it('classifies missing, zero, negative, NaN and non-numeric rarity as unknown (DUN-007)', () => {
    for (const r of [0, -1, Number.NaN, undefined, null, '5', {}]) {
      expect(getRarityTier(r).tier).toBe('unknown');
    }
    expect(getRarityTier(0.01).tier).toBe('legendary');
    expect(getRarityTier(100).tier).toBe('common');
    expect(getRarityTier(250).tier).toBe('common');
  });

  it('excludes unknown-rarity achievements from rarestUnlocked (DUN-007)', () => {
    upsertAchievements('Game3', [
      { apiName: 'a', displayName: 'A', unlocked: true, rarity: 0 },
      { apiName: 'b', displayName: 'B', unlocked: true, rarity: 60 },
    ]);
    expect(getAchievementProgress('Game3').rarestUnlocked?.tier).toBe('rare');

    upsertAchievements('Game4', [{ apiName: 'a', displayName: 'A', unlocked: true, rarity: 0 }]);
    const onlyUnknown = getAchievementProgress('Game4');
    expect(onlyUnknown.unlocked).toBe(1);
    expect(onlyUnknown.rarestUnlocked).toBeNull();
  });

  it('emits no placeholder icon/localRarity fields (DUN-109)', () => {
    upsertAchievements('Game5', [{ apiName: 'a', displayName: 'A', unlocked: false, rarity: 12 }]);
    const [detail] = getAchievementDetails('Game5');
    expect(detail).not.toHaveProperty('iconUrl');
    expect(detail).not.toHaveProperty('iconGrayUrl');
    expect(detail).not.toHaveProperty('localRarity');
  });
});
