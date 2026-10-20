import { describe, it, expect } from 'vitest';
import { t, availableLocales } from './index';

describe('i18n', () => {
  it('translates known keys', () => {
    expect(t('en', 'settings.theme')).toBe('Theme');
    expect(t('es', 'settings.theme')).toBe('Tema');
  });

  it('falls back for missing keys', () => {
    expect(t('en', 'missing.key', 'Fallback')).toBe('Fallback');
  });

  it('exposes locales', () => {
    expect(availableLocales).toContain('en');
    expect(availableLocales).toContain('es');
  });
});
