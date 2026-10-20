import { test, expect } from '@playwright/test';
import { installElectronStub, stubCalls } from './stub';
import { expectNoSeriousViolations } from './axe';

/** DUN-061 part 2: launch fields are main-only; the renderer sends ids and asks main to pick files. */
const games = [
  { id: 31, name: 'Hades', source: 'steam', steamAppId: '1145360' },
  { id: 32, name: 'Homebrew', source: 'manual' },
  { id: 33, name: 'Chrono Trigger', source: 'emulator' },
];
const prefixes = [{ id: 'p-a', name: 'GeneralWine', path: '/home/jane/.local/share/dune/prefixes/GeneralWine', createdAt: '2026-10-01T00:00:00.000Z' }];
const emulators = [{ id: 'snes9x', name: 'Snes9x' }];

const openPaths = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Game Paths', exact: true }).click();
};
const row = (page: import('@playwright/test').Page, name: string) => page.locator('.path-row').filter({ has: page.getByText(name, { exact: true }) });

test('add form has no executable field; add then main picks the file', async ({ page }) => {
  await installElectronStub(page, {});
  await openPaths(page);
  await expect(page.getByLabel(/executable/i)).toHaveCount(0);
  await page.locator('#new-game-title').fill('The Witcher 3: Wild Hunt™');
  await page.locator('#new-game-lin').fill('/home/jane/.local/share/witcher3/saves');
  await page.getByRole('button', { name: 'Save Mapping' }).click();
  await expect(page.locator('.toast-success')).toContainText('Added The Witcher 3: Wild Hunt™');
  const calls = await stubCalls(page);
  expect(calls.filter((c) => c.method === 'pickLaunchTarget')).toHaveLength(1);
  await expect(row(page, 'The Witcher 3: Wild Hunt™')).toContainText('Starts start.sh');
});

test('cancelled pick keeps the game as Not launchable yet with Choose executable…', async ({ page }) => {
  await installElectronStub(page, { pickLaunch: 'cancel' });
  await openPaths(page);
  await page.locator('#new-game-title').fill('Celeste');
  await page.locator('#new-game-lin').fill('/home/jane/.local/share/Celeste');
  await page.getByRole('button', { name: 'Save Mapping' }).click();
  await expect(page.locator('.toast-info')).toContainText('Choose its executable later');
  const r = row(page, 'Celeste');
  await expect(r).toContainText('Not launchable yet');
  await expect(r.getByRole('button', { name: 'Choose executable…' })).toBeVisible();
});

test('invalid pick shows a plain inline error', async ({ page }) => {
  await installElectronStub(page, { games, pickLaunch: 'invalid' });
  await openPaths(page);
  const r = row(page, 'Homebrew');
  await r.getByRole('button', { name: 'Choose executable…' }).click();
  await expect(r.getByRole('alert')).toHaveText('That file can’t be launched. Choose the game’s program file.');
});

test('prefix and emulator selects send ids only', async ({ page }) => {
  await installElectronStub(page, { games, prefixes, emulators });
  await openPaths(page);
  await expect(row(page, 'Hades')).toContainText('Starts through Steam');
  await expect(row(page, 'Hades').getByLabel('Wine prefix')).toHaveCount(0);

  const prefix = row(page, 'Homebrew').getByLabel('Wine prefix');
  await expect(prefix.locator('option')).toHaveText(['None', 'GeneralWine']);
  await prefix.selectOption('p-a');
  await expect(prefix).toHaveValue('p-a');
  await prefix.selectOption('');

  const emulator = row(page, 'Chrono Trigger').getByLabel('Emulator');
  await expect(row(page, 'Chrono Trigger')).toContainText('choose an emulator');
  await emulator.selectOption('snes9x');
  await expect(row(page, 'Chrono Trigger')).toContainText('Starts in the chosen emulator');

  const sent = (await stubCalls(page)).filter((c) => ['setGamePrefix', 'setGameEmulator'].includes(c.method));
  expect(sent).toEqual([
    { method: 'setGamePrefix', args: [32, 'p-a'] },
    { method: 'setGamePrefix', args: [32, null] },
    { method: 'setGameEmulator', args: [33, 'snes9x'] },
  ]);
  const saves = (await stubCalls(page)).filter((c) => c.method === 'saveConfig' && (c.args[0] as Record<string, unknown>).games);
  expect(saves).toEqual([]);
  await expectNoSeriousViolations(page, 'game paths launch settings');
});

test.describe('DUN-041: no server', () => {
  for (const [tab, heading, text] of [
    ['Playtime', 'Playtime Tracking', 'see playtime'],
    ['Achievements', 'Achievements', 'see and import achievements'],
    ['HLTB', 'HowLongToBeat', 'load HowLongToBeat times'],
  ] as const) {
    test(`${tab}: calm notice, no error toast, link to server field`, async ({ page }) => {
      await installElectronStub(page, { games });
      await page.goto('/');
      await page.locator('.sidebar').getByRole('button', { name: tab, exact: true }).click();
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
      await expect(page.getByText(`Connect a Dune server to ${text}`, { exact: false })).toBeVisible();
      await expect(page.locator('.toast-error')).toHaveCount(0);
      await expectNoSeriousViolations(page, `no-server ${tab}`);
      await page.getByRole('button', { name: 'Set up a server' }).click();
      await expect(page.locator('#server-url')).toBeFocused();
    });
  }
});

test.describe('DUN-042: drive card', () => {
  test('shows free space and plain reasons for unavailable drives', async ({ page }) => {
    await installElectronStub(page, {
      games: games.slice(1, 2),
      drives: [
        { paths: ['/home/jane'], mount: '/', label: 'System', status: 'ok', freeBytes: 25 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 },
        { paths: ['/media/usb/saves'], status: 'unavailable', reason: 'not-found' },
      ],
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Saves', exact: true }).click();
    const drives = page.getByRole('list', { name: 'Drives' });
    await expect(drives).toContainText('System');
    await expect(drives).toContainText('25.0 GB free');
    await expect(page.getByRole('meter', { name: 'System used space' })).toHaveAttribute('aria-valuenow', '75');
    await expect(drives).toContainText('Folder not found. It may be on a drive that is not connected.');
    await expect(drives).not.toContainText('not-found');
    await expectNoSeriousViolations(page, 'drive card', '.drive-list');
  });

  test('a failed read shows Drive info unavailable with Try again', async ({ page }) => {
    await installElectronStub(page, { drives: 'throw' });
    await page.goto('/');
    await page.getByRole('button', { name: 'Saves', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Drive info unavailable.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});
