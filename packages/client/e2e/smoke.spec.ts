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
      getAchievementSummary: async () => ({
        success: true,
        summary: [{ game: 'Hades', unlocked: 1, total: 2, percentage: 50 }],
      }),
      getRecentUnlocks: async () => ({ success: true, unlocks: [] }),
      getAchievementDetail: async () => ({
        success: true,
        achievements: [{
          id: 1,
          game: 'Hades',
          apiName: 'ACH_TEST',
          displayName: 'Test Achievement',
          description: 'A test unlock',
          unlocked: true,
          unlockTime: '2026-01-01T00:00:00.000Z',
          rarity: 5,
          localRarity: 0,
          hidden: false,
          iconUrl: '',
          iconGrayUrl: '',
          isSecret: false,
          steamApiName: 'ACH_TEST',
          createdAt: '',
          updatedAt: '',
        }],
        progress: {
          total: 1,
          unlocked: 1,
          percentage: 100,
          rarestUnlocked: { tier: 'legendary', minPercent: 0, maxPercent: 10, label: 'Legendary', color: '#FFD700' },
        },
      }),
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
      getServerKey: async () => ({ success: true, key: '' }),
      setServerKey: async () => ({ success: true }),
      launchGame: async (game: { name: string }) => ({ success: true, message: `Launched ${game.name}`, pid: 1234 }),
      getLaunchCommand: async () => ({ success: true, command: null }),
      listPrefixes: async () => ({
        success: true,
        prefixes: { wine: [], proton: [], heroic: [], lutris: [] },
      }),
      createPrefix: async () => ({ success: true, message: 'Prefix created' }),
      deletePrefix: async () => ({ success: true, message: 'Prefix deleted' }),
      backupPrefix: async () => ({ success: true, message: 'Prefix backed up', backupPath: '/tmp/prefix.backup' }),
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

test('settings exposes the server API key field', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const keyInput = page.locator('#server-api-key');
  await expect(keyInput).toBeVisible();
  await keyInput.fill('test-key-123');
  await expect(keyInput).toHaveValue('test-key-123');
});

test('achievements show rarity tiers and detail', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('#server-url').fill('http://localhost:3030');
  await page.getByRole('button', { name: 'Achievements', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Achievements' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Hades' })).toBeVisible();
  await page.getByRole('button', { name: 'View' }).click();
  await expect(page.getByText('Test Achievement')).toBeVisible();
  await expect(page.getByText('Legendary', { exact: true })).toBeVisible();
});

test('runtime manager lists prefix groups and create controls', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Prefixes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Prefix & Runtime Manager' })).toBeVisible();
  await expect(page.getByText('No Wine runtimes found.')).toBeVisible();
  await expect(page.getByText('No Proton runtimes found.')).toBeVisible();
  await expect(page.locator('#new-prefix-path')).toBeVisible();
});

test('game launch goes through the IPC bridge', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Game Paths', exact: true }).click();
  await page.locator('#new-game-title').fill('Test Game');
  await page.locator('#new-game-lin').fill('/tmp/test-game.sh');
  await page.getByRole('button', { name: 'Save Mapping' }).click();
  await expect(page.locator('.toast.toast-success')).toContainText('Added Test Game');

  await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
  await page.getByRole('button', { name: 'Launch', exact: true }).click();
  await expect(page.locator('.toast.toast-success').filter({ hasText: 'Launched Test Game' })).toBeVisible();
});
