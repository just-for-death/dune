/**
 * DUN-044: renderer i18n. English (`en.ts`) is the complete source catalog and
 * defines every MessageKey; other locales are partial and any key they lack
 * falls back to English, so the UI never shows a raw key.
 *
 * Templates use `{name}` placeholders. Counted strings use a `.one` / `.other`
 * key pair, picked with Intl.PluralRules for the active locale.
 */
import { en, type MessageKey } from './en';
import { es } from './es';

export type { MessageKey };
export type Messages = Partial<Record<MessageKey, string>>;

const catalogs = { en, es } satisfies Record<string, Messages>;

export type Locale = keyof typeof catalogs;
export const DEFAULT_LOCALE: Locale = 'en';
export const availableLocales = Object.keys(catalogs) as Locale[];

/** Endonyms for the language picker, so each option reads in its own language. */
export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', es: 'Español' };

export const LOCALE_STORAGE_KEY = 'dune:locale';

export type TranslationVars = Readonly<Record<string, string | number>>;
export type Translator = (key: MessageKey, vars?: TranslationVars) => string;

/** Base keys that have a `.one` / `.other` pair in the English catalog. */
export type PluralKey = { [K in MessageKey]: K extends `${infer Base}.one` ? Base : never }[MessageKey];
export type PluralTranslator = (key: PluralKey, count: number, vars?: TranslationVars) => string;

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(catalogs, value);
}

/** Replaces `{name}` with vars[name]; unknown placeholders are left visible. */
export function interpolate(template: string, vars?: TranslationVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

/** The catalog's text for `key`, or the English text when the catalog lacks it. */
export function messageFrom(messages: Messages, key: MessageKey): string {
  return messages[key] ?? en[key];
}

export function translate(locale: Locale, key: MessageKey, vars?: TranslationVars): string {
  return interpolate(messageFrom(catalogs[locale], key), vars);
}

export function createTranslator(locale: Locale): Translator {
  return (key, vars) => translate(locale, key, vars);
}

export function createPluralTranslator(locale: Locale): PluralTranslator {
  const rules = new Intl.PluralRules(locale);
  return (key, count, vars) => {
    const form = rules.select(count) === 'one' ? 'one' : 'other';
    return translate(locale, `${key}.${form}` as MessageKey, { count, ...vars });
  };
}

/** English translator: the default for services, so callers without a locale keep today's wording. */
export const defaultTranslator: Translator = createTranslator(DEFAULT_LOCALE);
export const defaultPluralTranslator: PluralTranslator = createPluralTranslator(DEFAULT_LOCALE);

/** Keys a locale does not translate yet (they render in English). */
export function missingKeys(locale: Locale): MessageKey[] {
  const messages: Messages = catalogs[locale];
  return (Object.keys(en) as MessageKey[]).filter((key) => messages[key] === undefined);
}

type LocaleStorage = Pick<Storage, 'getItem' | 'setItem'>;

function safeStorage(): LocaleStorage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** Saved locale, or English when nothing valid is stored (or storage is blocked). */
export function readStoredLocale(storage: LocaleStorage | undefined = safeStorage()): Locale {
  try {
    const value = storage?.getItem(LOCALE_STORAGE_KEY);
    return isLocale(value) ? value : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function writeStoredLocale(locale: Locale, storage: LocaleStorage | undefined = safeStorage()): void {
  try {
    storage?.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Storage full or blocked: the choice still applies for this session.
  }
}

/** Sets <html lang> so screen readers and hyphenation use the UI language. */
export function applyDocumentLocale(locale: Locale, doc: Pick<Document, 'documentElement'> | undefined =
  typeof document === 'undefined' ? undefined : document): void {
  if (doc) doc.documentElement.lang = locale;
}
