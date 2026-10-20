const translations = {
  en: {
    'app.title': 'Dune',
    'nav.dashboard': 'Dashboard',
    'nav.saves': 'Saves',
    'nav.settings': 'Settings',
    'settings.theme': 'Theme',
    'settings.language': 'Language',
  },
  es: {
    'app.title': 'Dune',
    'nav.dashboard': 'Panel',
    'nav.saves': 'Guardados',
    'nav.settings': 'Ajustes',
    'settings.theme': 'Tema',
    'settings.language': 'Idioma',
  },
} as const;

export type Locale = keyof typeof translations;
export const availableLocales: Locale[] = Object.keys(translations) as Locale[];

export function t(locale: Locale, key: string, fallback = key): string {
  const dictionary = translations[locale] as Record<string, string>;
  return dictionary[key] ?? (translations.en as Record<string, string>)[key] ?? fallback;
}
