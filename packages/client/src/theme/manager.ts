export interface ThemePack {
  id: string;
  name: string;
  author?: string;
  variables: Record<string, string>;
}

export const DEFAULT_THEME: ThemePack = {
  id: 'dune-dark',
  name: 'Dune Dark',
  author: 'Dune',
  variables: {
    '--bg': '#0e0f13',
    '--panel': '#15171d',
    '--panel-2': '#1b1e26',
    '--line': '#262b36',
    '--text': '#e9ebf1',
    '--muted': '#98a1b3',
    '--sand': '#e8b44a',
    '--sand-ink': '#1a1405',
    '--green': '#3fb950',
    '--red': '#f05548',
    '--cover': '#20242e',
  },
};

export function applyTheme(theme: ThemePack, root: { style: { setProperty(name: string, value: string): void } } = document.documentElement): void {
  for (const [name, value] of Object.entries(theme.variables)) {
    root.style.setProperty(name, value);
  }
}

export function loadThemes(storage: Pick<Storage, 'getItem'> | null = typeof localStorage !== 'undefined' ? localStorage : null): ThemePack[] {
  if (!storage) return [DEFAULT_THEME];
  try {
    const raw = storage.getItem('dune:themes');
    const parsed = raw ? (JSON.parse(raw) as ThemePack[]) : [];
    return [DEFAULT_THEME, ...parsed.filter((theme) => theme.id !== DEFAULT_THEME.id)];
  } catch {
    return [DEFAULT_THEME];
  }
}

export function saveTheme(theme: ThemePack, storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof localStorage !== 'undefined' ? localStorage : null): void {
  if (!storage) return;
  const themes = loadThemes(storage).filter((item) => item.id !== DEFAULT_THEME.id && item.id !== theme.id);
  themes.push(theme);
  storage.setItem('dune:themes', JSON.stringify(themes));
}

export function removeTheme(id: string, storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof localStorage !== 'undefined' ? localStorage : null): void {
  if (!storage || id === DEFAULT_THEME.id) return;
  const themes = loadThemes(storage).filter((theme) => theme.id !== id && theme.id !== DEFAULT_THEME.id);
  storage.setItem('dune:themes', JSON.stringify(themes));
}

export function getActiveThemeId(storage: Pick<Storage, 'getItem'> | null = typeof localStorage !== 'undefined' ? localStorage : null): string {
  return storage?.getItem('dune:activeTheme') || DEFAULT_THEME.id;
}

export function setActiveThemeId(id: string, storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof localStorage !== 'undefined' ? localStorage : null): void {
  storage?.setItem('dune:activeTheme', id);
}
