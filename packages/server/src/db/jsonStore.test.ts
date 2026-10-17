import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readJsonFile, writeJsonFileAtomic } from './jsonStore.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-jsonstore-test-'));

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('readJsonFile', () => {
  it('returns the fallback when the file does not exist', () => {
    expect(readJsonFile(path.join(TMP, 'missing.json'), { ok: true }, 'missing')).toEqual({ ok: true });
  });

  it('parses a valid JSON file', () => {
    const file = path.join(TMP, 'valid.json');
    fs.writeFileSync(file, JSON.stringify({ a: 1 }));
    expect(readJsonFile(file, {}, 'valid')).toEqual({ a: 1 });
  });

  it('preserves a corrupt file beside the original and returns the fallback', () => {
    const file = path.join(TMP, 'corrupt.json');
    fs.writeFileSync(file, '{not json');

    const result = readJsonFile(file, { fallback: true }, 'corrupt');
    expect(result).toEqual({ fallback: true });

    const backups = fs.readdirSync(TMP).filter(e => /^corrupt\.json\.corrupt-\d+$/.test(e));
    expect(backups).toHaveLength(1);
    // The quarantine holds the original bytes, untouched.
    expect(fs.readFileSync(path.join(TMP, backups[0]), 'utf-8')).toBe('{not json');
  });
});

describe('writeJsonFileAtomic', () => {
  it('writes valid JSON and leaves no temp file behind', () => {
    const file = path.join(TMP, 'written.json');
    writeJsonFileAtomic(file, { hello: 'world' });

    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ hello: 'world' });
    const leftovers = fs.readdirSync(TMP).filter(e => e.startsWith('written.json.tmp.'));
    expect(leftovers).toHaveLength(0);
  });
});
