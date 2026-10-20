import { test, expect, type Page } from '@playwright/test';
import { expectNoSeriousViolations } from './axe';
import { installElectronStub, sampleConflict, sampleGames } from './stub';

/**
 * Automated accessibility checks (axe-core) for the main views. The build is
 * served without Electron, with the IPC bridge stubbed (see stub.ts).
 * Only serious/critical violations fail the run; the rest are printed.
 */
async function openTab(page: Page, name: string) {
  await page.getByRole('button', { name, exact: true }).click();
}

test.describe('axe: main views', () => {
  test('library (dashboard) with games', async ({ page }) => {
    await installElectronStub(page, { games: sampleGames });
    await page.goto('/');
    await expect(page.locator('.game-card')).toHaveCount(sampleGames.length);
    await expectNoSeriousViolations(page, 'library');
  });

  test('library empty state', async ({ page }) => {
    await installElectronStub(page);
    await page.goto('/');
    await expect(page.locator('.empty-state')).toContainText('No games tracked yet');
    await expectNoSeriousViolations(page, 'library-empty');
  });

  test('game paths', async ({ page }) => {
    await installElectronStub(page, { games: sampleGames.slice(0, 2) });
    await page.goto('/');
    await openTab(page, 'Game Paths');
    await expect(page.getByRole('heading', { name: 'Game Path Mapping' })).toBeVisible();
    await expectNoSeriousViolations(page, 'game-paths');
  });

  test('settings', async ({ page }) => {
    await installElectronStub(page);
    await page.goto('/');
    await openTab(page, 'Settings');
    await expect(page.getByRole('heading', { name: 'Application Settings' })).toBeVisible();
    await expectNoSeriousViolations(page, 'settings');
  });

  test('saves (no conflict)', async ({ page }) => {
    await installElectronStub(page, { games: sampleGames.slice(0, 2), cloudUrl: 'http://localhost:3030' });
    await page.goto('/');
    await openTab(page, 'Saves');
    await expect(page.getByRole('heading', { name: 'Save Management' })).toBeVisible();
    await expect(page.getByText('No drives to show yet.', { exact: false })).toBeVisible();
    await expectNoSeriousViolations(page, 'saves');
  });

  test('saves with open conflict modal, then the review banner', async ({ page }) => {
    await installElectronStub(page, { games: sampleGames.slice(0, 2), ...sampleConflict });
    await page.goto('/');
    await openTab(page, 'Saves');
    const dialog = page.getByRole('dialog', { name: 'Save conflict detected' });
    await expect(dialog).toBeVisible();
    await expectNoSeriousViolations(page, 'conflict-modal');

    await dialog.getByRole('button', { name: 'Decide later' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Review conflict' })).toBeVisible();
    await expectNoSeriousViolations(page, 'saves-banner');
  });

  test('big picture with games', async ({ page }) => {
    await installElectronStub(page, { games: sampleGames });
    await page.goto('/');
    await openTab(page, 'Big Picture');
    await expect(page.locator('.big-picture-card')).toHaveCount(sampleGames.length);
    await expectNoSeriousViolations(page, 'big-picture');
  });

  test('big picture empty state', async ({ page }) => {
    await installElectronStub(page);
    await page.goto('/');
    await openTab(page, 'Big Picture');
    await expect(page.getByText('No games in your library yet.')).toBeVisible();
    await expectNoSeriousViolations(page, 'big-picture-empty');
  });

  test('toasts (error + info)', async ({ page }) => {
    await installElectronStub(page);
    await page.goto('/');
    await openTab(page, 'Game Paths');
    await page.locator('#new-game-title').fill('Hades');
    await page.getByRole('button', { name: 'Save Mapping' }).click();
    await expect(page.locator('.toast-error')).toBeVisible();
    await expectNoSeriousViolations(page, 'toasts');
  });
});
