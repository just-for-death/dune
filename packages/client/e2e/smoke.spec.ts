import { test, expect } from '@playwright/test';

/**
 * Smoke tests for the Dune dashboard renderer.
 * The Electron IPC bridge is stubbed before any page script runs, so no
 * backend, Electron binary, or display server is required.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    type StubEntry = { id: number; [key: string]: unknown };
    const games: StubEntry[] = [];
    // Server-calling IPC with no HTTP response (ServerFailure, code NETWORK).
    const network = async () => ({ ok: false, code: 'NETWORK', message: 'offline (e2e stub)' });
    const store = {
      games,
      cloud: { url: '' },
      settings: {
        runInBackground: false,
        autoSyncEnabled: false,
        autoSyncFreq: 'never',
        scanRoots: [],
      },
    };
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      loadConfig: async () => structuredClone(store),
      saveConfig: async (partial: Record<string, unknown>) => {
        Object.assign(store, structuredClone(partial));
        return true;
      },
      addGame: async (input: Record<string, unknown>) => {
        const now = new Date().toISOString();
        const entry = { winPath: '', linPath: '', lastSync: 'Never', status: 'Pending Upload', thumbnail: '', createdAt: now, updatedAt: now, ...input, id: Date.now() };
        store.games.push(entry);
        return { ok: true, game: entry, games: store.games };
      },
      removeGame: async (id: number) => {
        store.games = store.games.filter(g => g.id !== id);
        return { ok: true, games: store.games };
      },
      autoDetectGames: async () => ({ count: 0, currentGames: store.games }),
      selectDirectory: async () => ({ success: false }),
      testCloud: network,
      fetchArt: async () => ({ ok: false, code: 'NO_SERVER', message: 'No Dune Server configured' }),
      setCustomArt: async () => false,
      onSyncProgress: () => () => {},
      recordPlaytime: async () => ({ ok: true, success: true }),
      onPlaytimeRecorded: () => () => {},
      getPlaytimeSummary: async () => ({ ok: true, success: true, summary: [] }),
      getRecentSessions: async () => ({ ok: true, success: true, sessions: [] }),
      getTotalPlaytime: async () => ({ ok: true, success: true, totalMinutes: 0 }),
      getAchievements: async () => ({ ok: true, success: true, achievements: [] }),
      getAchievementSummary: async () => ({
        ok: true,
        success: true,
        summary: [{ game: 'Hades', unlocked: 1, total: 2, percentage: 50 }],
      }),
      getRecentUnlocks: async () => ({ ok: true, success: true, unlocks: [] }),
      importLocalAchievements: async () => ({ ok: true, success: true, count: 0, message: 'No local achievement files found' }),
      onAchievementsImported: () => () => {},
      getAchievementDetail: async () => ({
        ok: true,
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
      getHLTBTimes: network,
      analyzeFiles: network,
      searchArt: async () => ({ ok: true, success: true, results: [] }),
      autoMatchAll: async () => ({ ok: true, success: true, count: 0 }),
      triggerLocalSync: async () => ({ ok: true, success: true, count: 0, games: [] }),
      getLocalSources: async () => ({ ok: true, success: true, sources: [] }),
      addLocalSource: network,
      removeLocalSource: async () => ({ ok: true, success: true }),
      getRemoteServers: async () => ({ ok: true, success: true, servers: [] }),
      addRemoteServer: network,
      removeRemoteServer: async () => ({ ok: true, success: true }),
      getApiKeys: async () => ({ ok: true, success: true, keys: [] }),
      addApiKey: async () => ({ ok: true, success: true }),
      removeApiKey: async () => ({ ok: true, success: true }),
      getOllamaModels: async () => ({ ok: true, success: true, models: [] }), // DUN-095: no endpoint argument
      checkOllamaHealth: network,
      // DUN-073: write-only; only { set } comes back.
      getServerKey: async () => ({ set: false }),
      setServerKey: async (key: string) => ({ set: key !== '' }),
      getSteamGridKeyStatus: async () => ({ ok: false, code: 'NO_SERVER', message: 'No Dune Server configured' }),
      setSteamGridKey: async () => ({ ok: false, code: 'NO_SERVER', message: 'No Dune Server configured' }),
      clearSteamGridKey: async () => ({ ok: false, code: 'NO_SERVER', message: 'No Dune Server configured' }),
      listSaveFiles: async () => ({ ok: true, files: [], truncated: false }),
      launchGame: async () => ({ ok: true, pid: 1234 }),
      pickLaunchTarget: async (id: number) => {
        const game = store.games.find(g => g.id === id);
        if (!game) return { ok: false, reason: 'not-found' };
        Object.assign(game, { executable: '/tmp/test-game.sh' });
        return { ok: true, game };
      },
      setGamePrefix: async (id: number, prefixId: string | null) => ({ ok: true, game: { ...store.games.find(g => g.id === id), managedPrefixId: prefixId ?? undefined } }),
      listEmulators: async () => [],
      setGameEmulator: async () => ({ ok: false, reason: 'not-emulator' }),
      getDiskSpace: async () => [],
      getLaunchCommand: async () => ({ ok: false, reason: 'not-launchable' }),
      listPrefixes: async () => [],
      createPrefix: async (name: string) => ({ ok: true, prefix: { id: 'p1', name, path: `/tmp/prefixes/${name}`, createdAt: '2026-01-01T00:00:00.000Z' } }),
      deletePrefix: async () => ({ ok: true, trashedPath: '/tmp/Trash/p1' }),
      backupPrefix: async () => ({ ok: true, backupPath: '/tmp/prefix.backup' }),
      getSaveVersions: async () => ({ ok: true, success: true, versions: [] }),
      getStorage: async () => ({ ok: true, success: true }),
      getBackupProfile: async () => ({ ok: true, success: true }),
      setBackupProfile: async (profile: Record<string, unknown>) => ({ ok: true, success: true, profile }),
      getConflicts: async () => ({ ok: true, success: true, conflicts: [] }),
      resolveConflict: async () => ({ ok: true, success: true }),
      restoreSaveVersion: async () => ({ ok: true, success: true, message: 'Restored' }),
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

test('mapping validates empty game title inline', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Game Paths', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Add New Custom Mapping' })).toBeVisible();
  await page.getByRole('button', { name: 'Save Mapping' }).click();
  await expect(page.locator('#new-game-title-error')).toHaveText('Enter the game title.');
  await expect(page.locator('#new-game-title')).toBeFocused();
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
  // DUN-041: a calm notice, no error toast.
  await expect(page.getByText('Connect a Dune server to see playtime across your devices.', { exact: false })).toBeVisible();
  await expect(page.locator('.toast.toast-error')).toHaveCount(0);
});

test('settings exposes the server API key field', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const keyInput = page.locator('#server-api-key');
  await expect(keyInput).toBeVisible();
  await keyInput.fill('test-key-123');
  await expect(keyInput).toHaveValue('test-key-123');
});

test('save manager switches between tracked games', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('#server-url').fill('http://localhost:3030');

  await page.getByRole('button', { name: 'Game Paths', exact: true }).click();
  for (const name of ['Alpha', 'Beta']) {
    await page.locator('#new-game-title').fill(name);
    await page.locator('#new-game-lin').fill(`/tmp/${name.toLowerCase()}.sh`);
    await page.getByRole('button', { name: 'Save Mapping' }).click();
    await expect(page.locator('.toast.toast-success').filter({ hasText: `Added ${name}` })).toBeVisible();
  }

  await page.getByRole('button', { name: 'Saves', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Save Management' })).toBeVisible();
  const picker = page.locator('#save-game-select');
  await expect(picker).toHaveValue('Alpha');
  await picker.selectOption('Beta');
  await expect(picker).toHaveValue('Beta');
});

test('local achievements can be imported for a tracked game', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('#server-url').fill('http://localhost:3030');
  await page.getByRole('button', { name: 'Game Paths', exact: true }).click();
  await page.locator('#new-game-title').fill('Hades');
  await page.locator('#new-game-lin').fill('/tmp/hades.sh');
  await page.getByRole('button', { name: 'Save Mapping' }).click();

  await page.getByRole('button', { name: 'Achievements', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Local Achievement Import' })).toBeVisible();
  await page.getByRole('button', { name: 'Scan local files' }).click();
  await expect(page.locator('.toast.toast-info').filter({ hasText: 'No local achievement files found' })).toBeVisible();
});

test('achievements show rarity tiers and detail', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('#server-url').fill('http://localhost:3030');
  await page.getByRole('button', { name: 'Achievements', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Achievements' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Hades', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'View' }).click();
  await expect(page.getByText('Test Achievement')).toBeVisible();
  await expect(page.getByText('Legendary', { exact: true })).toBeVisible();
});

test('prefix manager lists Dune prefixes and create controls', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Prefixes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Prefix & Runtime Manager' })).toBeVisible();
  await expect(page.getByText('No prefixes yet. Create one above.')).toBeVisible();
  await expect(page.getByLabel('Prefix name')).toBeVisible();
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
