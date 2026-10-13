import { test, expect } from '@playwright/test';

/**
 * Smoke tests for the Dune dashboard renderer.
 * The Electron IPC bridge is stubbed before any page script runs, so no
 * backend, Electron binary, or display server is required.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const store = {
      games: [],
      cloud: { url: '' },
      settings: {
        runInBackground: false,
        autoSyncEnabled: false,
        autoSyncFreq: 'never',
        steamGridDbKey: '',
        scanRoots: [],
      },
    };
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      loadConfig: async () => structuredClone(store),
      saveConfig: async (partial: Record<string, unknown>) => {
        Object.assign(store, structuredClone(partial));
        return true;
      },
      addGame: async (game: Record<string, unknown>) => {
        const entry = { ...game, id: Date.now() };
        (store.games as unknown[]).push(entry);
        return store.games;
      },
      removeGame: async (id: number) => {
        store.games = (store.games as { id: number }[]).filter(g => g.id !== id);
        return store.games;
      },
      autoDetectGames: async () => ({ count: 0, currentGames: store.games }),
      selectDirectory: async () => ({ success: false }),
      testCloud: async () => ({ success: false, message: 'offline (e2e stub)' }),
      fetchArt: async () => ({ success: false, message: 'offline (e2e stub)' }),
      setCustomArt: async () => false,
      onSyncProgress: () => () => {},
      recordPlaytime: async () => ({ success: true }),
      getPlaytimeSummary: async () => ({ success: true, summary: [] }),
      getRecentSessions: async () => ({ success: true, sessions: [] }),
      getTotalPlaytime: async () => ({ success: true, totalMinutes: 0 }),
      getAchievements: async () => ({ success: true, achievements: [] }),
      getAchievementSummary: async () => ({ success: true, summary: [] }),
      getRecentUnlocks: async () => ({ success: true, unlocks: [] }),
      getHLTBTimes: async () => ({ success: false, message: 'offline (e2e stub)' }),
      analyzeFiles: async () => ({ success: false, message: 'offline (e2e stub)' }),
      searchArt: async () => ({ success: true, results: [] }),
      autoMatchAll: async () => ({ success: true, count: 0 }),
      triggerLocalSync: async () => ({ success: true, count: 0, games: [] }),
      getLocalSources: async () => ({ success: true, sources: [] }),
      addLocalSource: async () => ({ success: false, message: 'offline (e2e stub)' }),
      removeLocalSource: async () => ({ success: true }),
      getRemoteServers: async () => ({ success: true, servers: [] }),
      addRemoteServer: async () => ({ success: false, message: 'offline (e2e stub)' }),
      removeRemoteServer: async () => ({ success: true }),
      getApiKeys: async () => ({ success: true, keys: [] }),
      addApiKey: async () => ({ success: true }),
      removeApiKey: async () => ({ success: true }),
      getOllamaModels: async () => ({ success: true, models: [] }),
      checkOllamaHealth: async () => ({ success: false, message: 'offline (e2e stub)' }),
    };
  });
});

test('dashboard renders with nav, stats, and empty state', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.sidebar-title')).toHaveText('Dune');
  await expect(page.getByRole('button', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  // Zero-game stats
  await expect(page.locator('.stat-value').first()).toHaveText('0');
  // Empty state with CTA into mapping tab
  await expect(page.locator('.empty-state')).toContainText('No games tracked yet');
  await page.locator('.empty-state button').click();
  await expect(page.getByRole('heading', { name: 'Game Path Mapping' })).toBeVisible();
});

test('mapping validates empty game title with a toast', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Game Paths', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Add New Custom Mapping' })).toBeVisible();
  await page.getByRole('button', { name: 'Save Mapping' }).click();
  const toast = page.locator('.toast.toast-error');
  await expect(toast).toContainText('Game title is required');
});

test('search filters the game grid', async ({ page }) => {
  await page.goto('/');
  const search = page.locator('.search-input');
  await expect(search).toBeVisible();
  await search.fill('hades');
  // No games stubbed: filtered empty state offers clearing the search
  await expect(page.locator('.empty-state')).toContainText('hades');
  await page.locator('.empty-state button').click();
  await expect(search).toHaveValue('');
});

test('playtime tab degrades gracefully without a server URL', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Playtime' }).click();
  await expect(page.getByRole('heading', { name: 'Playtime Tracking' })).toBeVisible();
  await expect(page.locator('.toast.toast-error')).toContainText('Configure Dune Server URL first');
});
