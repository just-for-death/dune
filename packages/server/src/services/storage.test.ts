import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanDirectorySize, scanStorage, getDriveFreeBytes } from './storage.js';

describe('storage service', () => {
  it('scans directory size', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-storage-'));
    fs.writeFileSync(path.join(dir, 'save.sav'), '12345');
    fs.mkdirSync(path.join(dir, 'cache'));
    fs.writeFileSync(path.join(dir, 'cache', 'shader.cache'), 'abcdef');

    const result = scanDirectorySize(dir);
    expect(result.fileCount).toBe(2);
    expect(result.bytes).toBe(11);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('classifies save and cache bytes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-storage2-'));
    fs.writeFileSync(path.join(dir, 'slot.sav'), 'save');
    fs.mkdirSync(path.join(dir, 'cache'));
    fs.writeFileSync(path.join(dir, 'cache', 'shader.cache'), 'cache');

    const result = scanStorage(dir, '2026-01-01T00:00:00.000Z');
    expect(result.saveBytes).toBe(4);
    expect(result.cacheBytes).toBe(5);
    expect(result.lastPlayed).toBe('2026-01-01T00:00:00.000Z');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns a non-negative drive free value', () => {
    expect(getDriveFreeBytes(os.tmpdir())).toBeGreaterThanOrEqual(0);
  });
});
