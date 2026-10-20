import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dataDir, packageDataDir } from '../utils/path.js';

// DUN-005: src/test/setup.ts (vitest setupFiles) must hand every test file a
// private temp DATA_DIR that is never the real <package>/data folder.
describe('test setup DATA_DIR (DUN-005)', () => {
  const dir = process.env.DATA_DIR;

  it('sets DATA_DIR to a fresh dune-test- dir under the OS temp dir', () => {
    expect(dir).toBeTruthy();
    const real = fs.realpathSync(dir as string);
    expect(path.dirname(real)).toBe(fs.realpathSync(os.tmpdir()));
    expect(path.basename(real)).toMatch(/^dune-test-/);
    expect(fs.statSync(real).isDirectory()).toBe(true);
  });

  it('is not the real data folder', () => {
    expect(path.resolve(dir as string)).not.toBe(path.resolve(packageDataDir()));
    expect(path.relative(packageDataDir(), dir as string).startsWith('..')).toBe(true);
  });

  it('is what dataDir() resolves to', () => {
    expect(dataDir()).toBe(dir);
  });
});
