import { describe, expect, it } from 'vitest';
import type { Game } from '@dune/shared';
import { importLocalAchievementsFromDisk } from './import.js';
import type { LocalAchievement } from './local.js';

const game: Game = {
  id: 1,
  name: 'Import Test',
  winPath: '',
  linPath: '/tmp/import-test',
  lastSync: 'Never',
  status: 'In Sync',
  thumbnail: '',
  createdAt: '',
  updatedAt: '',
};

function achievement(apiName: string): LocalAchievement {
  return {
    apiName,
    displayName: apiName,
    unlocked: true,
    unlockTime: '2026-01-01T00:00:00.000Z',
  };
}

describe('local achievement import', () => {
  it('posts scanned achievements and returns the server count', async () => {
    const posted: LocalAchievement[] = [];
    const result = await importLocalAchievementsFromDisk(
      game,
      async (name, achievements) => {
        expect(name).toBe('Import Test');
        posted.push(...achievements);
        return { success: true, count: 2 };
      },
      () => [achievement('ACH_ONE'), achievement('ACH_TWO')],
    );

    expect(result).toEqual({ success: true, count: 2 });
    expect(posted.map((entry) => entry.apiName)).toEqual(['ACH_ONE', 'ACH_TWO']);
  });

  it('skips the transport when no local files are found', async () => {
    let called = false;
    const result = await importLocalAchievementsFromDisk(
      game,
      async () => {
        called = true;
        return { success: true, count: 0 };
      },
      () => [],
    );

    expect(result.success).toBe(true);
    expect(result.count).toBe(0);
    expect(called).toBe(false);
  });

  it('surfaces transport failures without throwing', async () => {
    const result = await importLocalAchievementsFromDisk(
      game,
      async () => { throw new Error('server offline'); },
      () => [achievement('ACH_ONE')],
    );

    expect(result).toEqual({ success: false, count: 0, message: 'server offline' });
  });
});
