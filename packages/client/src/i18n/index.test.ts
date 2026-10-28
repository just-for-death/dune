import { describe, it, expect } from 'vitest';
import { en } from './en';
import { es } from './es';
import {
  applyDocumentLocale,
  availableLocales,
  createPluralTranslator,
  createTranslator,
  interpolate,
  isLocale,
  LOCALE_NAMES,
  LOCALE_STORAGE_KEY,
  messageFrom,
  missingKeys,
  readStoredLocale,
  translate,
  writeStoredLocale,
  type MessageKey,
} from './index';

const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    data,
  };
}

describe('i18n catalogs', () => {
  it('lists English and Spanish with endonym names', () => {
    expect(availableLocales).toEqual(['en', 'es']);
    expect(LOCALE_NAMES).toEqual({ en: 'English', es: 'Español' });
  });

  it('English is complete: every key has non-empty text', () => {
    for (const [key, text] of Object.entries(en)) expect(text.trim(), key).not.toBe('');
    expect(missingKeys('en')).toEqual([]);
  });

  it('Spanish only uses known keys, keeps every placeholder, and is never empty', () => {
    for (const [key, text] of Object.entries(es)) {
      expect(Object.prototype.hasOwnProperty.call(en, key), `unknown key ${key}`).toBe(true);
      expect(text?.trim(), key).not.toBe('');
      expect(placeholders(text ?? ''), key).toEqual(placeholders(en[key as MessageKey]));
    }
  });

  it('every counted string has both forms', () => {
    for (const key of Object.keys(en)) {
      if (key.endsWith('.one')) expect(en, key).toHaveProperty([key.replace(/\.one$/, '.other')]);
    }
  });
});

describe('translate', () => {
  it('switches text by locale', () => {
    expect(translate('en', 'settings.language')).toBe('Language');
    expect(translate('es', 'settings.language')).toBe('Idioma');
    expect(createTranslator('es')('nav.saves')).toBe('Guardados');
  });

  it('falls back to English for a key the locale lacks', () => {
    expect(messageFrom({}, 'settings.theme')).toBe('Theme');
    expect(messageFrom({ 'settings.theme': 'Tema' }, 'settings.theme')).toBe('Tema');
    for (const key of missingKeys('es')) expect(translate('es', key)).toBe(en[key]);
  });

  it('fills placeholders and leaves unknown ones visible', () => {
    expect(translate('en', 'games.removed', { name: 'Hades' })).toBe('Removed Hades');
    expect(translate('es', 'games.removed', { name: 'Hades' })).toBe('Hades quitado');
    expect(interpolate('{a} and {b}', { a: 1 })).toBe('1 and {b}');
    expect(interpolate('{toString}', {})).toBe('{toString}');
  });

  it('picks the plural form for the locale', () => {
    const enCount = createPluralTranslator('en');
    expect(enCount('sidebar.games', 1)).toBe('1 game');
    expect(enCount('sidebar.games', 0)).toBe('0 games');
    expect(enCount('dashboard.searchCount', 6, { matched: 2 })).toBe('2 of 6 games match');
    const esCount = createPluralTranslator('es');
    expect(esCount('sidebar.games', 1)).toBe('1 juego');
    expect(esCount('sidebar.games', 3)).toBe('3 juegos');
  });
});

describe('locale persistence and <html lang>', () => {
  it('validates locales', () => {
    expect(isLocale('es')).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(isLocale('__proto__')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });

  it('reads the saved locale and ignores junk', () => {
    expect(readStoredLocale(memoryStorage({ [LOCALE_STORAGE_KEY]: 'es' }))).toBe('es');
    expect(readStoredLocale(memoryStorage({ [LOCALE_STORAGE_KEY]: 'xx' }))).toBe('en');
    expect(readStoredLocale(memoryStorage())).toBe('en');
    expect(readStoredLocale(undefined)).toBe('en');
    const blocked = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(readStoredLocale(blocked)).toBe('en');
    expect(() => writeStoredLocale('es', blocked)).not.toThrow();
  });

  it('writes the chosen locale', () => {
    const storage = memoryStorage();
    writeStoredLocale('es', storage);
    expect(storage.data.get(LOCALE_STORAGE_KEY)).toBe('es');
    expect(readStoredLocale(storage)).toBe('es');
  });

  it('sets the document language', () => {
    const doc = { documentElement: { lang: 'en' } } as unknown as Document;
    applyDocumentLocale('es', doc);
    expect(doc.documentElement.lang).toBe('es');
  });
});
