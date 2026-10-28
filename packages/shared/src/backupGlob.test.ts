import { describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUDE_GLOBS, matchesGlob } from './backupGlob';

describe('matchesGlob (DUN-136)', () => {
  it('**/ matches zero or more directories', () => {
    expect(matchesGlob('run.log', '**/*.log')).toBe(true);
    expect(matchesGlob('a/b/run.log', '**/*.log')).toBe(true);
    expect(matchesGlob('saves/slot1.sav', '**/*.sav')).toBe(true);
    expect(matchesGlob('saves/slot1.sav.bak', '**/*.sav')).toBe(false);
  });
  it('* and ? stay inside one segment; backslashes and case are normalised', () => {
    expect(matchesGlob('a/run.log', '*.log')).toBe(false);
    expect(matchesGlob('slot1.sav', 'slot?.sav')).toBe(true);
    expect(matchesGlob('slot10.sav', 'slot?.sav')).toBe(false);
    expect(matchesGlob('A\\B\\RUN.LOG', '**/*.log')).toBe(true);
    expect(matchesGlob('x.sav', '')).toBe(true);
  });
  it('regex metacharacters in patterns are literal', () => {
    expect(matchesGlob('save(1).dat', 'save(1).dat')).toBe(true);
    expect(matchesGlob('saveX1Ydat', 'save(1).dat')).toBe(false);
  });

  const cases: Array<[string, boolean]> = [
    ['run.log', true], ['a/b/run.log', true], ['x.tmp', true], ['d/x.cache', true],
    ['cache/f.bin', true], ['g/Cache/f.bin', true], ['ShaderCache/a/b.bin', true],
    ['p/crashdumps/d.dmp', true], ['CrashDumps/d.dmp', true], ['screenshots/s.png', true],
    ['u/Screenshots/s.png', true], ['logs/a.txt', true], ['x/Logs/y/a.txt', true],
    ['saves/slot1.sav', false], ['cachefile.sav', false], ['mylogs/a.txt', false],
    ['profile/settings.ini', false], ['saves/log.sav', false], ['screenshots.dat', false],
  ];
  it.each(cases)('DEFAULT_EXCLUDE_GLOBS: %s excluded=%s', (rel, excluded) => {
    expect(DEFAULT_EXCLUDE_GLOBS.some((g) => matchesGlob(rel, g))).toBe(excluded);
  });
});
