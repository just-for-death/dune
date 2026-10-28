import { createContext, createElement, Fragment, useContext, type ReactNode } from 'react';
import {
  DEFAULT_LOCALE,
  defaultPluralTranslator,
  defaultTranslator,
  type Locale,
  type PluralTranslator,
  type Translator,
} from './index';

export interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translator;
  /** Counted strings: `tc('sidebar.games', 3)` -> "3 games". */
  tc: PluralTranslator;
}

/** Outside a provider (unit tests rendering one component) the UI is English and read-only. */
export const I18nContext = createContext<I18nValue>({
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  t: defaultTranslator,
  tc: defaultPluralTranslator,
});

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}

/**
 * Fills `{name}` placeholders with React nodes (e.g. a <strong>), so a whole
 * sentence stays one translatable string.
 */
export function formatRich(template: string, parts: Readonly<Record<string, ReactNode>>): ReactNode {
  const children = template.split(/(\{\w+\})/g).map((piece) => {
    const match = /^\{(\w+)\}$/.exec(piece);
    return match && Object.prototype.hasOwnProperty.call(parts, match[1]) ? parts[match[1]] : piece;
  });
  return createElement(Fragment, null, ...children);
}
