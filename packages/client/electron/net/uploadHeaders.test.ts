import { describe, it, expect } from 'vitest';
import { validateHeaderValue } from 'node:http';
import { ENCODED_UPLOAD_HEADERS, uploadFileHeaders } from './uploadHeaders';

// DUN-064 / DUN-127: Node's own header check (the one that threw
// ERR_INVALID_CHAR) is used directly; no request is sent.
const titles = ['DARK SOULS™ III', 'The Witcher 3: Wild Hunt', '原神', 'ファイナルファンタジーXIV'];
const paths = ['セーブ.dat', 'slot 1/save™.sav', '存档/进度 01.sav', 'a%2Fb.sav'];

describe('uploadFileHeaders', () => {
  it('raw titles outside Latin-1 are rejected by Node (the bug)', () => {
    expect(() => validateHeaderValue('x-game', 'DARK SOULS™ III')).toThrow(/Invalid character/);
    expect(() => validateHeaderValue('x-path', 'セーブ.dat')).toThrow();
  });

  it.each(titles.flatMap((t) => paths.map((p) => [t, p])))('%s / %s: valid header values that decode back exactly', (title, rel) => {
    const h = uploadFileHeaders(title, rel, '1760946000000');
    for (const [name, value] of Object.entries(h)) expect(() => validateHeaderValue(name, value)).not.toThrow();
    expect(decodeURIComponent(h['x-game'])).toBe(title);
    expect(decodeURIComponent(h['x-path'])).toBe(rel);
    expect(h['x-sync-id']).toBe('1760946000000');
  });

  it('encodes exactly x-game and x-path; a literal % is encoded too', () => {
    expect([...ENCODED_UPLOAD_HEADERS]).toEqual(['x-game', 'x-path']);
    expect(uploadFileHeaders('100% Orange Juice', 'a.sav', '1')['x-game']).toBe('100%25%20Orange%20Juice');
  });

  it('accepts only 1-20 decimal digits as the sync id (server rule)', () => {
    expect(() => uploadFileHeaders('G', 'a', '')).toThrow();
    expect(() => uploadFileHeaders('G', 'a', 'id™')).toThrow();
    expect(() => uploadFileHeaders('G', 'a', 'abc')).toThrow();
    expect(() => uploadFileHeaders('G', 'a', '12-3')).toThrow();
    expect(() => uploadFileHeaders('G', 'a', '1'.repeat(21))).toThrow();
    expect(() => uploadFileHeaders('G', 'a', '1'.repeat(20))).not.toThrow();
  });
});
