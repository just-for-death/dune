import { describe, expect, it } from 'vitest';
import { checkGameTitle } from './gameTitle';

describe('checkGameTitle', () => {
  it('accepts colons, trademarks, quotes and accents as written', () => {
    for (const title of ['The Witcher 3: Wild Hunt', 'DARK SOULS™ III', 'Baldur\'s Gate "3"', 'Pokémon: Légendes', 'a/b\\c?*<>|']) {
      expect(checkGameTitle(title)).toEqual({ ok: true, value: title });
    }
  });
  it('trims', () => {
    expect(checkGameTitle('  Hades  ')).toEqual({ ok: true, value: 'Hades' });
  });
  it('maps each failure to plain wording', () => {
    expect(checkGameTitle('   ')).toEqual({ ok: false, error: 'Enter the game title.' });
    expect(checkGameTitle('Ha\0des')).toMatchObject({ ok: false, error: expect.stringContaining('hidden character') });
    expect(checkGameTitle('Ha\tdes')).toMatchObject({ ok: false, error: expect.stringContaining('tabs or line breaks') });
    expect(checkGameTitle('x'.repeat(201))).toEqual({ ok: false, error: 'Use at most 200 characters.' });
    expect(checkGameTitle('x'.repeat(200)).ok).toBe(true);
  });
  it('never shows a raw code', () => {
    for (const bad of ['', 'a\0', 'a\u0007', 'y'.repeat(300)]) {
      const r = checkGameTitle(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).not.toMatch(/EMPTY|NUL\b|CONTROL|TOO_LONG/);
    }
  });
});
