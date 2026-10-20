import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  validateGameTitle,
  validateRelativeSavePath,
  MAX_GAME_TITLE_LENGTH,
  MAX_SEGMENT_BYTES,
  MAX_RELATIVE_PATH_LENGTH,
  type PathRuleCode,
  type PathRuleResult,
} from './pathRules.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function codeOf(r: PathRuleResult): PathRuleCode | 'OK' {
  return r.ok ? 'OK' : r.code;
}

describe('validateGameTitle', () => {
  it.each([
    ['The Witcher 3: Wild Hunt', 'The Witcher 3: Wild Hunt'],
    ['DARK SOULS™ III', 'DARK SOULS™ III'],
    ['"Quoted" Game?', '"Quoted" Game?'],
    ['AC/DC Live', 'AC/DC Live'],
    ['  Hades  ', 'Hades'],
    ['.', '.'],
    ['..', '..'],
    ['遊'.repeat(MAX_GAME_TITLE_LENGTH), '遊'.repeat(MAX_GAME_TITLE_LENGTH)],
  ])('accepts %j as %j', (title, value) => {
    expect(validateGameTitle(title)).toEqual({ ok: true, value });
  });

  it.each<[unknown, PathRuleCode]>([
    ['', 'EMPTY'],
    ['   ', 'EMPTY'],
    [undefined, 'EMPTY'],
    [42, 'EMPTY'],
    ['a\0b', 'NUL'],
    ['tab\there', 'CONTROL'],
    ['line\nbreak', 'CONTROL'],
    ['esc\x1b', 'CONTROL'],
    ['del\x7f', 'CONTROL'],
    ['a'.repeat(MAX_GAME_TITLE_LENGTH + 1), 'TOO_LONG'],
  ])('rejects %j with %s', (title, code) => {
    const r = validateGameTitle(title);
    expect(codeOf(r)).toBe(code);
    if (!r.ok) expect(r.message).toMatch(/\S/);
  });
});

describe('validateRelativeSavePath', () => {
  it.each([
    ['slot1.sav', 'slot1.sav'],
    ['Saves/slot1.sav', 'Saves/slot1.sav'],
    ['Saves\\Profile 1\\slot1.sav', 'Saves/Profile 1/slot1.sav'],
    ['.config/game.ini', '.config/game.ini'],
    ['saves.zip', 'saves.zip'],
    ['..%2F..%2Fx', '..%2F..%2Fx'], // literal name: not decoded, not a '..' segment
  ])('accepts %j as %j', (p, value) => {
    expect(validateRelativeSavePath(p)).toEqual({ ok: true, value });
  });

  it.each<[unknown, PathRuleCode]>([
    ['', 'EMPTY'],
    [null, 'EMPTY'],
    ['a//b', 'EMPTY'],
    ['a/', 'EMPTY'],
    ['x\0.sav', 'NUL'],
    ['../../../sentinel.txt', 'DOT_SEGMENT'],
    ['../../usr_other/Hades/slot2.sav', 'DOT_SEGMENT'],
    ['Saves/../../x', 'DOT_SEGMENT'],
    ['Saves\\..\\..\\x', 'DOT_SEGMENT'],
    ['./slot.sav', 'DOT_SEGMENT'],
    ['Saves/./slot.sav', 'DOT_SEGMENT'],
    ['Saves/.../x', 'DOT_SEGMENT'],
    ['/etc/x', 'ABSOLUTE'],
    ['C:\\x', 'ABSOLUTE'],
    ['C:/x', 'ABSOLUTE'],
    ['c:x', 'ABSOLUTE'],
    ['\\\\server\\x', 'ABSOLUTE'],
    ['\\x', 'ABSOLUTE'],
    ['Saves/CON', 'RESERVED'],
    ['Saves/aux.sav', 'RESERVED'],
    ['Saves/LPT¹', 'RESERVED'],
    ['slot.sav:hidden', 'RESERVED'],
    ['Saves/a|b.sav', 'CHANGED_BY_SANITIZE'],
    ['Saves/tab\there.sav', 'CHANGED_BY_SANITIZE'],
    ['Saves/slot.sav.', 'CHANGED_BY_SANITIZE'],
    ['Saves /slot.sav', 'CHANGED_BY_SANITIZE'],
    [`${'a'.repeat(MAX_SEGMENT_BYTES + 1)}/x`, 'TOO_LONG'],
    [Array.from({ length: 300 }, () => 'abcd').join('/'), 'TOO_LONG'],
  ])('rejects %j with %s', (p, code) => {
    expect(codeOf(validateRelativeSavePath(p))).toBe(code);
  });

  it('caps the whole path at MAX_RELATIVE_PATH_LENGTH characters', () => {
    const ok = Array.from({ length: MAX_RELATIVE_PATH_LENGTH / 4 }, () => 'abc').join('/');
    expect(ok.length).toBeLessThanOrEqual(MAX_RELATIVE_PATH_LENGTH);
    expect(validateRelativeSavePath(ok).ok).toBe(true);
  });

  it('counts UTF-8 bytes per segment, including 2-, 3- and 4-byte characters', () => {
    expect(validateRelativeSavePath('😀'.repeat(63)).ok).toBe(true); // 252 bytes
    expect(codeOf(validateRelativeSavePath('😀'.repeat(64)))).toBe('TOO_LONG'); // 256
    expect(codeOf(validateRelativeSavePath('é'.repeat(128)))).toBe('TOO_LONG'); // 256
    expect(validateRelativeSavePath('遊'.repeat(85)).ok).toBe(true); // 255
  });

  it('only normalizes separators; segments come back unchanged', () => {
    for (const p of ['a/b/c.sav', 'a\\b\\c.sav', 'Ünï/遊戲.sav']) {
      const r = validateRelativeSavePath(p);
      expect(r.ok && r.value.split('/').join('|')).toBe(p.split(/[\\/]/).join('|'));
    }
  });
});

describe('renderer-safe module (no Node / Buffer / DOM globals)', () => {
  it('pathRules.ts source imports nothing from node:, fs, path or buffer and never uses Buffer', () => {
    const src = fs.readFileSync(path.join(HERE, 'pathRules.ts'), 'utf-8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bimport\b[^;]*['"](node:[^'"]*|fs|path|buffer|os|crypto|url)['"]/);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/\bBuffer\b/);
    expect(code).not.toMatch(/\b(TextEncoder|window|document|process)\b/);
    // No imports at all: the module is self-contained.
    expect(code).not.toMatch(/^\s*import\s/m);
  });

  it('built dist/pathRules.js runs in a plain ESM context with Buffer/process stripped', () => {
    const dist = path.join(HERE, '..', 'dist', 'pathRules.js');
    expect(fs.existsSync(dist), 'run `npm run build` in packages/shared first').toBe(true);
    const script = `
      const log = console.log.bind(console);
      delete globalThis.Buffer;
      delete globalThis.process;
      const m = await import(${JSON.stringify(pathToFileURL(dist).href)});
      log(JSON.stringify({
        title: m.validateGameTitle('DARK SOULS™ III'),
        badTitle: m.validateGameTitle('a\\u0001b'),
        rel: m.validateRelativeSavePath('Saves\\\\slot1.sav'),
        bad: m.validateRelativeSavePath('../../x'),
        long: m.validateRelativeSavePath('😀'.repeat(64)),
      }));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf-8' });
    const res = JSON.parse(out.trim().split('\n').pop() as string);
    expect(res.title).toEqual({ ok: true, value: 'DARK SOULS™ III' });
    expect(res.badTitle.code).toBe('CONTROL');
    expect(res.rel).toEqual({ ok: true, value: 'Saves/slot1.sav' });
    expect(res.bad.code).toBe('DOT_SEGMENT');
    expect(res.long.code).toBe('TOO_LONG');
  });
});
