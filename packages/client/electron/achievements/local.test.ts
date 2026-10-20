import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  findAchievementFiles,
  getAchievementRoots,
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

  it('parses Goldberg/CODEX style INI state', () => {
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

  it('discovers files without descending into skipped system directories', () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'steam_settings'), { recursive: true });
    fs.mkdirSync(path.join(root, 'Windows', 'System32'), { recursive: true });
    const settings = path.join(root, 'steam_settings', 'achievements.ini');
    fs.writeFileSync(settings, '[ACHIEVEMENTS]\nACH_ONE=1\n');
    fs.writeFileSync(path.join(root, 'Windows', 'System32', 'achievements.ini'), '[ACHIEVEMENTS]\nBAD=1\n');

    expect(findAchievementFiles([root])).toEqual([settings]);
    const parsed = scanLocalAchievements([root]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].apiName).toBe('ACH_ONE');
  });

  it('merges duplicate achievements across files', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'achievements.ini'), '[ACHIEVEMENTS]\nACH_DUPE=0\n');
    fs.writeFileSync(path.join(root, 'user_stats.json'), JSON.stringify({
      achievements: { ACH_DUPE: { earned: true, earned_time: '2026-01-01T00:00:00Z' } },
    }));

    const parsed = scanLocalAchievements([root]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].unlocked).toBe(true);
    expect(parsed[0].unlockTime).toBe('2026-01-01T00:00:00.000Z');
  });

  it('builds roots for an executable and a Wine prefix', () => {
    const root = tempDir();
    const exe = path.join(root, 'Game', 'game.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, '');
    const prefix = path.join(root, 'prefix');

    const roots = getAchievementRoots({
      linPath: exe,
      winPath: '',
      executable: exe,
      winePrefix: prefix,
    });

    expect(roots).toContain(path.dirname(exe));
    expect(roots).toContain(path.join(prefix, 'drive_c'));
  });
});
