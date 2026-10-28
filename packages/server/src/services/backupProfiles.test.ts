import { describe, it, expect } from 'vitest';
import { matchesGlob, DEFAULT_EXCLUDE_GLOBS } from '@dune/shared';
import { filterBackupFiles } from './backupProfiles.js';

describe('backupProfiles', () => {
  it('matches common exclusion globs', () => {
    expect(matchesGlob('foo.log', '**/*.log')).toBe(true);
    expect(matchesGlob('ShaderCache/file.bin', '**/ShaderCache/**')).toBe(true);
    expect(matchesGlob('saves/slot1.sav', '**/*.sav')).toBe(true);
  });

  it('filters included and excluded files', () => {
    const files = [
      { path: 'saves/slot1.sav', size: 100 },
      { path: 'cache/shader.bin', size: 200 },
      { path: 'logs/game.log', size: 50 },
    ];
    const profile = {
      gameId: 1,
      includeGlobs: ['**/*'],
      excludeGlobs: [...DEFAULT_EXCLUDE_GLOBS],
      autoExcludeCache: true,
      updatedAt: new Date().toISOString(),
    };

    const result = filterBackupFiles(files, profile);
    expect(result.included).toHaveLength(1);
    expect(result.excluded).toHaveLength(2);
    expect(result.included.map((f) => f.path)).toEqual(['saves/slot1.sav']);
  });
});
