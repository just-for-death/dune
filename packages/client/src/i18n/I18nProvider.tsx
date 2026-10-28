import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { I18nContext, type I18nValue } from './context';
import {
  applyDocumentLocale,
  createPluralTranslator,
  createTranslator,
  isLocale,
  readStoredLocale,
  writeStoredLocale,
  type Locale,
} from './index';

interface Props {
  children: ReactNode;
  /** Starting locale; defaults to the saved choice (or English). */
  initialLocale?: Locale;
}

export function I18nProvider({ children, initialLocale }: Props) {
  const [locale, setLocaleState] = useState<Locale>(() => initialLocale ?? readStoredLocale());

  const setLocale = useCallback((next: Locale) => {
    if (!isLocale(next)) return;
    setLocaleState(next);
    writeStoredLocale(next);
  }, []);

  useEffect(() => {
    applyDocumentLocale(locale);
  }, [locale]);

  const value = useMemo<I18nValue>(
    () => ({ locale, setLocale, t: createTranslator(locale), tc: createPluralTranslator(locale) }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
