import { describe, expect, it } from 'vitest';
import type { PrefixOpFailureReason } from '@dune/shared';
import { MAX_PREFIX_NAME, prefixFailureMessage, validateNewPrefixName } from './prefixes';

const ALL: PrefixOpFailureReason[] = ['not-found', 'not-managed', 'symlink', 'outside-root', 'invalid-name', 'exists', 'in-use', 'trash-failed', 'error'];

describe('validateNewPrefixName', () => {
  it('rejects empty and whitespace', () => {
    expect(validateNewPrefixName('').ok).toBe(false);
    expect(validateNewPrefixName('   ').ok).toBe(false);
  });
  it('trims and accepts a name', () => {
    expect(validateNewPrefixName('  MyGame ')).toEqual({ ok: true, value: 'MyGame' });
  });
  it('enforces the length limit', () => {
    expect(validateNewPrefixName('a'.repeat(MAX_PREFIX_NAME)).ok).toBe(true);
    expect(validateNewPrefixName('a'.repeat(MAX_PREFIX_NAME + 1)).ok).toBe(false);
  });
});

describe('prefixFailureMessage', () => {
  it('maps every code to a plain sentence without the raw code', () => {
    for (const op of ['create', 'backup', 'delete'] as const) {
      for (const code of ALL) {
        const message = prefixFailureMessage(op, code);
        expect(message).toMatch(/\.$/);
        expect(message).toContain(' ');
        // No hyphenated code (e.g. "outside-root") leaks into the text.
        for (const raw of ALL.filter(c => c.includes('-'))) expect(message).not.toContain(raw);
      }
    }
  });
  it('falls back for unknown or missing codes', () => {
    expect(prefixFailureMessage('delete', 'weird')).toBe(prefixFailureMessage('delete', 'error'));
    expect(prefixFailureMessage('delete', undefined)).toBe(prefixFailureMessage('delete', 'error'));
    expect(prefixFailureMessage('delete', '__proto__')).toBe(prefixFailureMessage('delete', 'error'));
  });
  it('says nothing was deleted when the trash fails', () => {
    expect(prefixFailureMessage('delete', 'trash-failed')).toContain('Nothing was deleted');
  });
});
