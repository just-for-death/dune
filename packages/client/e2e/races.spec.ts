import { test, expect } from '@playwright/test';
import { installElectronStub, stubCalls, type StubOptions } from './stub';

/**
 * DUN-046: switching games quickly must never let a slow reply for the
 * previous game overwrite the Saves view or open the wrong conflict, and rapid
 * "View" clicks in Achievements must show the last game clicked.
 */
const SLOW_MS = 800;
// Pre-fix code loaded the four Saves calls one after another, so allow all of them to land.
const ALL_SLOW_REPLIES_MS = 4 * SLOW_MS + 500;
const version = (id: string, gameId: number, changeSummary: string) => ({
  id, gameId, createdAt: '2026-01-02T10:00:00.000Z', sizeBytes: 1024 * 1024, fileCount: 2, changeSummary, status: 'complete' as const,
});

const raceSeed = (withBetaConflict: boolean): StubOptions => ({
  games: [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Beta' }],
  cloudUrl: 'http://localhost:3030',
  delayMs: { Alpha: SLOW_MS },
  perGame: {
    Alpha: {
      versions: [version('a1', 1, 'alpha-change'), version('a2', 1, 'alpha-old')],
      conflicts: [{ id: 'conflict-alpha', gameId: 1, localVersionId: 'a1', remoteVersionId: 'a2', detectedAt: '2026-01-01T00:00:00.000Z' }],
    },
    Beta: {
      versions: [version('b1', 2, 'beta-change'), version('b2', 2, 'beta-old')],
      conflicts: withBetaConflict
        ? [{ id: 'conflict-beta', gameId: 2, localVersionId: 'b1', remoteVersionId: 'b2', detectedAt: '2026-01-01T00:00:00.000Z' }]
        : [],
    },
  },
});

test('slow reply for game A does not overwrite game B in Saves', async ({ page }) => {
  await installElectronStub(page, raceSeed(false));
  await page.goto('/');
  await page.getByRole('button', { name: 'Saves', exact: true }).click();
  const picker = page.locator('#save-game-select');
  await expect(picker).toHaveValue('Alpha'); // Alpha's slow load is now in flight
  await picker.selectOption('Beta');

  const timeline = page.locator('.save-timeline');
  await expect(timeline).toContainText('beta-change');
  // Let Alpha's delayed replies land, then check B's data stayed.
  await page.waitForTimeout(ALL_SLOW_REPLIES_MS);
  await expect(picker).toHaveValue('Beta');
  await expect(timeline).toContainText('beta-change');
  await expect(timeline).not.toContainText('alpha');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review conflict' })).toHaveCount(0);
});

test('only the selected game\'s conflict opens, and resolve targets it', async ({ page }) => {
  await installElectronStub(page, raceSeed(true));
  await page.goto('/');
  await page.getByRole('button', { name: 'Saves', exact: true }).click();
  await page.locator('#save-game-select').selectOption('Beta');

  const dialog = page.getByRole('dialog', { name: 'Save conflict detected' });
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(ALL_SLOW_REPLIES_MS); // Alpha's conflict reply arrives late and must be ignored
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep local copy' }).click();
  await expect(dialog).toBeHidden();

  const resolves = (await stubCalls(page)).filter((c) => c.method === 'resolveConflict');
  expect(resolves).toEqual([{ method: 'resolveConflict', args: ['conflict-beta', 'local'] }]);
  await page.waitForTimeout(300);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('rapid "View" clicks in Achievements show the last game clicked', async ({ page }) => {
  await installElectronStub(page, {
    games: [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Beta' }],
    cloudUrl: 'http://localhost:3030',
    achievementGames: ['Alpha', 'Beta'],
    delayMs: { Alpha: SLOW_MS },
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Achievements', exact: true }).click();
  const rows = page.locator('.data-table tbody tr');
  await expect(rows).toHaveCount(2);
  await rows.filter({ hasText: 'Alpha' }).getByRole('button', { name: 'View' }).click();
  await rows.filter({ hasText: 'Beta' }).getByRole('button', { name: 'View' }).click();

  await expect(page.getByText('Beta first steps')).toBeVisible();
  await page.waitForTimeout(SLOW_MS + 500);
  await expect(page.getByText('Beta first steps')).toBeVisible();
  await expect(page.getByText('Alpha first steps')).toHaveCount(0);
  await expect(page.locator('.card-title').filter({ hasText: 'unlocked' })).toContainText('Beta');
});
