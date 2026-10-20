import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import setup, { newEntries, topLevelEntries, PACKAGE_ROOT } from './globalSetup.js';

describe('leak guard (globalSetup)', () => {
  it('points at packages/server', () => {
    expect(fs.existsSync(path.join(PACKAGE_ROOT, 'vitest.config.ts'))).toBe(true);
  });

  it('flags new top-level entries, ignores pre-existing ones and coverage/', () => {
    expect(newEntries(['a', 'TestGame'], ['a', 'TestGame', 'coverage'])).toEqual([]);
    expect(newEntries(['a'], ['a', 'TestGame', 'test-saves'])).toEqual(['TestGame', 'test-saves']);
  });

  it('teardown throws on a leak (checked against a temp root, never the package)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-leakguard-'));
    try {
      const before = topLevelEntries(root);
      fs.mkdirSync(path.join(root, 'Leaked'));
      expect(newEntries(before, topLevelEntries(root))).toEqual(['Leaked']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    expect(typeof setup).toBe('function');
  });
});
