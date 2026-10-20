import { test, expect, type Page } from '@playwright/test';
import { expectNoSeriousViolations } from './axe';
import { installElectronStub, sampleGames } from './stub';

/**
 * DUN-047..050: landmarks, playtime chart text alternatives, the sync
 * progressbar + live status, and the Smart exclusions rollback.
 */
const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const openTab = (page: Page, name: string) => nav(page).getByRole('button', { name, exact: true }).click();

test.describe('DUN-048 landmarks', () => {
  test('one Main navigation with aria-current on the active tab, and one main', async ({ page }) => {
    await installElectronStub(page, { games: sampleGames.slice(0, 2) });
    await page.goto('/');
    await expect(nav(page)).toHaveCount(1);
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('main').getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    const current = nav(page).locator('[aria-current="page"]');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveText('Dashboard');

    await openTab(page, 'Saves');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveText('Saves');
    await expect(nav(page).getByRole('button', { name: 'Dashboard', exact: true })).not.toHaveAttribute('aria-current');
  });
});

const graph = {
  line: [{ date: '2026-10-01', minutes: 30 }, { date: '2026-10-02', minutes: 1234 }],
  bar: [{ game: 'Hades', minutes: 1234 }, { game: 'Celeste', minutes: 45 }],
  pie: [{ game: 'Hades', minutes: 1234, percentage: 96.5 }, { game: 'Celeste', minutes: 45, percentage: 3.5 }],
  heatmap: [],
  area: [],
};

test.describe('DUN-049 playtime charts', () => {
  test('charts are named images with a legend and formatted values', async ({ page }) => {
    await installElectronStub(page, {
      cloudUrl: 'http://localhost:3030',
      playtime: {
        graph,
        comparison: {
          current: { period: 'month', totalMinutes: 150, sessions: 3 },
          previous: { period: 'month', totalMinutes: 100, sessions: 2 },
          difference: { minutes: 50, percentage: 50, sessions: 1 },
        },
      },
    });
    await page.goto('/');
    await openTab(page, 'Playtime');

    const charts = page.locator('.playtime-charts');
    await expect(charts.getByRole('img', { name: 'Cumulative playtime from 2026-10-01 to 2026-10-02, reaching 20h 34m.' })).toBeVisible();
    await expect(charts.getByRole('img', { name: 'Playtime distribution across 2 games. Most played: Hades, 97%.' })).toBeVisible();

    const legend = charts.getByRole('list', { name: 'Distribution legend' });
    await expect(legend.getByRole('listitem')).toHaveText(['Hades20h 34m (97%)', 'Celeste45m (4%)']);

    await expect(charts.locator('.bar-row').filter({ hasText: 'Hades' }).locator('.bar-value')).toHaveText('20h 34m');
    await expect(charts).not.toContainText('1234m');

    const comparison = charts.locator('section').filter({ has: page.getByRole('heading', { name: 'Period comparison' }) });
    await expect(comparison).toContainText('2h 30m');
    await expect(comparison).toContainText('1h 40m');
    await expect(comparison).toContainText('+50%');
    await expect(charts.locator('.card')).toHaveCount(0);

    // The line chart's data is also available as a (visually hidden) table.
    await expect(charts.getByRole('table', { name: 'Cumulative playtime by date' })).toHaveCount(1);
    await expectNoSeriousViolations(page, 'playtime-charts', '.playtime-charts');
  });

  test('comparison against an empty previous period says New, never Infinity', async ({ page }) => {
    await installElectronStub(page, {
      cloudUrl: 'http://localhost:3030',
      playtime: {
        graph,
        comparison: {
          current: { period: 'month', totalMinutes: 30, sessions: 1 },
          previous: { period: 'month', totalMinutes: 0, sessions: 0 },
          difference: { minutes: 30, percentage: 0, sessions: 1 },
        },
      },
    });
    await page.goto('/');
    await openTab(page, 'Playtime');
    const comparison = page.locator('.playtime-charts section').filter({ has: page.getByRole('heading', { name: 'Period comparison' }) });
    await expect(comparison).toContainText('New');
    await expect(comparison).not.toContainText(/Infinity|NaN/);
  });
});

test.describe('DUN-050 sync progress', () => {
  test('a failed sync shows a progressbar and announces the failure', async ({ page }) => {
    await installElectronStub(page, {
      cloudUrl: 'http://localhost:3030',
      syncFail: { ok: false, status: 500, code: 'INTERNAL', message: 'The server disk is full.' },
    });
    await page.goto('/');
    await openTab(page, 'Server Sync');
    await page.getByRole('button', { name: 'Push Saves to Server' }).click();

    const card = page.locator('.sync-progress-card');
    const bar = card.getByRole('progressbar', { name: 'Sync progress' });
    await expect(bar).toHaveAttribute('aria-valuemin', '0');
    await expect(bar).toHaveAttribute('aria-valuemax', '100');
    await expect(bar).toHaveAttribute('aria-valuenow', '0');
    const status = card.getByRole('status');
    await expect(status).toHaveAttribute('aria-live', 'polite');
    await expect(status).toHaveText('Sync Failed: The server disk is full.');
    await expect(card).not.toContainText('INTERNAL');
  });

  test('the default stub failure (no server) uses plain wording', async ({ page }) => {
    await installElectronStub(page, { cloudUrl: 'http://localhost:3030' });
    await page.goto('/');
    await openTab(page, 'Server Sync');
    await page.getByRole('button', { name: 'Push Saves to Server' }).click();
    await expect(page.locator('.sync-progress-card').getByRole('status')).toHaveText('Sync Failed: Connect a Dune server first.');
  });

  test('the finished card hides after a few seconds, and a new run restarts the timer', async ({ page }) => {
    await page.clock.install();
    await installElectronStub(page, { cloudUrl: 'http://localhost:3030' });
    await page.goto('/');
    await openTab(page, 'Server Sync');
    const push = page.getByRole('button', { name: 'Push Saves to Server' });
    const card = page.locator('.sync-progress-card');

    await push.click();
    await expect(card).toBeVisible();
    await page.clock.runFor(3000);
    await push.click(); // second run: the first run's timer must not hide this card early
    await page.clock.runFor(2000);
    await expect(card).toBeVisible();
    await page.clock.runFor(2500);
    await expect(card).toHaveCount(0);
  });
});

test.describe('DUN-047 Smart exclusions rollback', () => {
  // Production builds have no file breakdown (DEMO_EXCLUSION_FILES is DEV-only
  // and no IPC provides one yet), so the editor has no toggles to click under
  // `vite preview`. The rollback is unit-tested in
  // src/services/backupProfileSave.test.ts. Enable this once a real
  // file-breakdown source exists.
  // DUN-131: enable once Desktop's listSaveFiles(gameId) IPC lands and replaces the DEV-only exclusion demo files.
  test.fixme('a failed save rolls the editor back and shows an error toast', async ({ page }) => {
    await installElectronStub(page, {
      games: sampleGames.slice(0, 1),
      cloudUrl: 'http://localhost:3030',
      backupProfile: { gameId: 1, includeGlobs: ['**/*'], excludeGlobs: [], autoExcludeCache: false, updatedAt: '2026-10-20T00:00:00.000Z' },
      backupProfileFail: { ok: false, status: 403, code: 'FORBIDDEN', message: 'Admin privileges required' },
    });
    await page.goto('/');
    await openTab(page, 'Saves');
    const cache = page.locator('.exclusion-editor').getByRole('checkbox', { name: /Cache/ });
    await expect(cache).not.toBeChecked();
    await cache.check();
    await expect(page.locator('.toast-error')).toContainText('This needs an admin key.');
    await expect(cache).not.toBeChecked();
  });
});
