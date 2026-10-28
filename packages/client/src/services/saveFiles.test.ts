import { describe, expect, it } from 'vitest';
import type { SaveFileListResult } from '@dune/shared';
import { en } from '../i18n/en';
import {
  CATEGORY_GLOBS,
  SAVE_FILE_LIST_REJECTED,
  categorizeSaveFile,
  matchesCategoryGlob,
  saveFileListFailureKey,
  saveFileListState,
} from './saveFiles';

describe('matchesCategoryGlob', () => {
  it('matches extension globs on the file name only', () => {
    expect(matchesCategoryGlob('slot1.sav', '**/*.sav')).toBe(true);
    expect(matchesCategoryGlob('a/b/slot1.sav', '**/*.sav')).toBe(true);
    expect(matchesCategoryGlob('slot1.sav.bak', '**/*.sav')).toBe(false);
  });
  it('matches folder globs on folder segments, not the file name', () => {
    expect(matchesCategoryGlob('cache/shader.bin', '**/cache/**')).toBe(true);
    expect(matchesCategoryGlob('x/cache/y/shader.bin', '**/cache/**')).toBe(true);
    expect(matchesCategoryGlob('cache', '**/cache/**')).toBe(false);
    expect(matchesCategoryGlob('ShaderCache/file.bin', '**/Cache/**')).toBe(false);
  });
  it('is case-sensitive and accepts backslash paths', () => {
    expect(matchesCategoryGlob('CACHE/x.bin', '**/cache/**')).toBe(false);
    expect(matchesCategoryGlob('Saves\\slot.dat', '**/Saves/**')).toBe(true);
  });
  it('rejects empty paths and unsupported glob shapes', () => {
    expect(matchesCategoryGlob('', '**/*.sav')).toBe(false);
    expect(matchesCategoryGlob('a.sav', '*.sav')).toBe(false);
  });
});

describe('categorizeSaveFile', () => {
  it.each([
    ['saves/slot1.sav', 'Save'],
    ['SaveGames/profile.dat', 'Save'],
    ['settings.ini', 'Config'],
    ['config/keys.json', 'Config'],
    ['config/slot.sav', 'Save'],
    ['saves/debug.log', 'Cache'],
    ['logs/run.txt', 'Cache'],
    ['tmp.cache', 'Cache'],
    ['screenshot.png', 'Other'],
  ] as const)('%s is %s', (path, category) => {
    expect(categorizeSaveFile(path)).toBe(category);
  });
  it('puts every categorized file under a glob that excluding the category writes', () => {
    for (const path of ['saves/a.sav', 'a.ini', 'cache/a', 'a.tmp']) {
      const category = categorizeSaveFile(path);
      expect(CATEGORY_GLOBS[category].some(glob => matchesCategoryGlob(path, glob))).toBe(true);
    }
  });
});

describe('saveFileListState', () => {
  it('categorizes files and keeps the truncated flag', () => {
    const res: SaveFileListResult = {
      ok: true,
      truncated: true,
      files: [
        { path: 'saves/slot1.sav', size: 10, mtimeMs: 1 },
        { path: 'cache/s.bin', size: 20, mtimeMs: 2 },
      ],
    };
    expect(saveFileListState(res)).toEqual({
      status: 'ready',
      truncated: true,
      files: [
        { path: 'saves/slot1.sav', size: 10, category: 'Save' },
        { path: 'cache/s.bin', size: 20, category: 'Cache' },
      ],
    });
  });
  it.each([
    ['GAME_NOT_FOUND', 'exclusions.error.gameNotFound'],
    ['NO_SAVE_PATH', 'exclusions.error.noSavePath'],
    ['PROTECTED_SAVE_PATH', 'exclusions.error.protectedSavePath'],
    ['LOCAL_ERROR', 'exclusions.error.local'],
  ] as const)('maps %s to %s', (code, key) => {
    expect(saveFileListState({ ok: false, code })).toEqual({ status: 'error', messageKey: key });
    expect(en[key].length).toBeGreaterThan(0);
  });
  it('reads unknown codes and rejections as a local error', () => {
    expect(saveFileListFailureKey('SOMETHING_NEW')).toBe('exclusions.error.local');
    expect(saveFileListFailureKey('toString')).toBe('exclusions.error.local');
    expect(SAVE_FILE_LIST_REJECTED).toEqual({ status: 'error', messageKey: 'exclusions.error.local' });
  });
});
