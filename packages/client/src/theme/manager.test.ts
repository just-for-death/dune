import { describe, it, expect } from 'vitest';
import { applyTheme, loadThemes, saveTheme, removeTheme, getActiveThemeId, setActiveThemeId, DEFAULT_THEME } from './manager';

describe('theme manager', () => {
  it('applies variables to a root', () => {
    const root = { style: { values: {} as Record<string, string>, setProperty(name: string, value: string) { this.values[name] = value; } } };
    applyTheme(DEFAULT_THEME, root);
    expect(root.style.values['--sand']).toBe('#e8b44a');
  });

  it('loads and saves themes with injected storage', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    };
    const custom = { id: 'custom', name: 'Custom', variables: { '--sand': '#ff0000' } };
    saveTheme(custom, storage);
    const themes = loadThemes(storage);
    expect(themes.map((theme) => theme.id)).toContain('custom');
    expect(getActiveThemeId(storage)).toBe(DEFAULT_THEME.id);
    setActiveThemeId('custom', storage);
    expect(getActiveThemeId(storage)).toBe('custom');
    removeTheme('custom', storage);
    expect(loadThemes(storage).some((theme) => theme.id === 'custom')).toBe(false);
  });
});
