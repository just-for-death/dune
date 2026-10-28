import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  findAchievementFiles,
  getAchievementRoots,
  prefixAchievementDirs,
  parseAchievementIni,
  parseAchievementJson,
  scanLocalAchievements,
} from './local.js';

describe('local achievement import', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    tempDirs.length = 0;
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-ach-'));
    tempDirs.push(dir);
    return dir;
  }

  it('parses local achievement file format INI state', () => {
    const parsed = parseAchievementIni(`
      ; comment
      [ACHIEVEMENTS]
      ACH_FIRST=1
      ACH_SECOND=0
      ACH_THIRD=unlocked,2026-01-02T03:04:05Z
      Count=3
    `);

    expect(parsed).toHaveLength(3);
    expect(parsed.find(a => a.apiName === 'ACH_FIRST')).toMatchObject({ unlocked: true, unlockTime: null });
    expect(parsed.find(a => a.apiName === 'ACH_SECOND')).toMatchObject({ unlocked: false });
    expect(parsed.find(a => a.apiName === 'ACH_THIRD')?.unlockTime).toBe('2026-01-02T03:04:05.000Z');
  });

  it('parses nested JSON achievement maps and epoch timestamps', () => {
    const parsed = parseAchievementJson(JSON.stringify({
      achievements: {
        ACH_JSON: {
          displayName: 'JSON Achievement',
          earned: true,
          earned_time: 1767225600,
        },
        ACH_LOCKED: {
          name: 'Still Locked',
          achieved: false,
        },
      },
    }));

    expect(parsed).toHaveLength(2);
    expect(parsed.find(a => a.apiName === 'ACH_JSON')).toMatchObject({
      displayName: 'JSON Achievement',
      unlocked: true,
    });
    expect(parsed.find(a => a.apiName === 'ACH_JSON')?.unlockTime).toBe('2026-01-01T00:00:00.000Z');
    expect(parsed.find(a => a.apiName === 'ACH_LOCKED')?.unlocked).toBe(false);
  });

  it('discovers files without descending into skipped system directories', async () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'steam_settings'), { recursive: true });
    fs.mkdirSync(path.join(root, 'Windows', 'System32'), { recursive: true });
    const settings = path.join(root, 'steam_settings', 'achievements.ini');
    fs.writeFileSync(settings, '[ACHIEVEMENTS]\nACH_ONE=1\n');
    fs.writeFileSync(path.join(root, 'Windows', 'System32', 'achievements.ini'), '[ACHIEVEMENTS]\nBAD=1\n');

    expect(await findAchievementFiles([root])).toEqual([settings]);
    const parsed = await scanLocalAchievements([root]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].apiName).toBe('ACH_ONE');
  });

  it('merges duplicate achievements across files', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'achievements.ini'), '[ACHIEVEMENTS]\nACH_DUPE=0\n');
    fs.writeFileSync(path.join(root, 'user_stats.json'), JSON.stringify({
      achievements: { ACH_DUPE: { earned: true, earned_time: '2026-01-01T00:00:00Z' } },
    }));

    const parsed = await scanLocalAchievements([root]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].unlocked).toBe(true);
    expect(parsed[0].unlockTime).toBe('2026-01-01T00:00:00.000Z');
  });

  it('builds roots for an executable; a prefix adds only its per-appId folders (DUN-076)', async () => {
    const root = tempDir();
    const exe = path.join(root, 'Game', 'game.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, '');
    const prefix = path.join(root, 'prefix');
    const goldberg = path.join(prefix, 'drive_c', 'users', 'steamuser', 'AppData', 'Roaming', 'Goldberg SteamEmu Saves', '620');
    const codex = path.join(prefix, 'drive_c', 'users', 'Public', 'Documents', 'Steam', 'CODEX', '620');
    const otherGame = path.join(prefix, 'drive_c', 'users', 'steamuser', 'AppData', 'Roaming', 'Goldberg SteamEmu Saves', '999');
    for (const d of [goldberg, codex, otherGame]) fs.mkdirSync(d, { recursive: true });

    const roots = await getAchievementRoots({ executable: exe, winePrefix: prefix, steamAppId: '620' });

    expect(roots).toContain(path.dirname(exe));
    expect(roots).toContain(goldberg);
    expect(roots).toContain(codex);
    expect(roots).not.toContain(otherGame);
    expect(roots).not.toContain(path.join(prefix, 'drive_c'));
  });

  it('a shared prefix never leaks another game\'s achievements (DUN-076)', async () => {
    const root = tempDir();
    const prefix = path.join(root, 'wine');
    const mine = path.join(prefix, 'drive_c', 'users', 'me', 'AppData', 'Roaming', 'GSE Saves', '100');
    const other = path.join(prefix, 'drive_c', 'users', 'me', 'AppData', 'Roaming', 'GSE Saves', '200');
    const loose = path.join(prefix, 'drive_c', 'Games', 'Other');
    for (const d of [mine, other, loose]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(mine, 'achievements.json'), JSON.stringify({ MINE: { earned: true, earned_time: 1700000000 } }));
    fs.writeFileSync(path.join(other, 'achievements.json'), JSON.stringify({ OTHER: { earned: true, earned_time: 1700000000 } }));
    fs.writeFileSync(path.join(loose, 'achievements.ini'), '[ACHIEVEMENTS]\nLOOSE=1\n');

    const parsed = await scanLocalAchievements(await getAchievementRoots({ winePrefix: prefix, steamAppId: '100' }));
    expect(parsed.map((a) => a.apiName)).toEqual(['MINE']);
  });

  it('without a Steam app id a prefix is not scanned at all; bad app ids are refused', async () => {
    const root = tempDir();
    const prefix = path.join(root, 'wine');
    fs.mkdirSync(path.join(prefix, 'drive_c', 'users', 'me', 'AppData', 'Roaming', 'GSE Saves', '100'), { recursive: true });
    expect(await getAchievementRoots({ winePrefix: prefix })).toEqual([]);
    expect(await prefixAchievementDirs(prefix, '../100')).toEqual([]);
  });

  it('scans asynchronously (returns a promise, never blocks on sync fs)', () => {
    const p = scanLocalAchievements([tempDir()]);
    expect(p).toBeInstanceOf(Promise);
    return p;
  });
});
