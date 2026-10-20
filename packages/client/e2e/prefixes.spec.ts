import { test, expect } from '@playwright/test';
import { installElectronStub, sampleGames, stubCalls, type StubPrefix } from './stub';
import { expectNoSeriousViolations } from './axe';

/** DUN-062: prefixes are Dune-managed, created by name and changed by id. */
const prefixes: StubPrefix[] = [
  { id: 'p-hades', name: 'Hades', path: '/home/jane/.local/share/dune/prefixes/Hades', createdAt: '2026-10-01T10:00:00.000Z' },
  { id: 'p-long', name: 'Disco', path: `/home/jane/.local/share/dune/prefixes/${'a-very-long-folder-name-'.repeat(6)}Disco`, createdAt: '2026-10-02T10:00:00.000Z' },
];

const openPrefixes = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Prefixes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dune prefixes' })).toBeVisible();
};

test('lists managed prefixes with name and path, no raw codes, axe clean', async ({ page }) => {
  await installElectronStub(page, { prefixes });
  await openPrefixes(page);
  await expect(page.getByText('Hades', { exact: true })).toBeVisible();
  await expect(page.getByText(prefixes[0].path)).toBeVisible();
  const overflow = await page.locator('.prefix-list').evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expectNoSeriousViolations(page, 'prefixes');
});

test('create validates the name inline and creates by name', async ({ page }) => {
  await installElectronStub(page, { prefixes });
  await openPrefixes(page);
  const name = page.getByLabel('Prefix name');
  await page.getByRole('button', { name: 'Create Prefix' }).click();
  await expect(page.locator('#new-prefix-error')).toHaveText('Enter a name for the prefix.');
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  expect((await stubCalls(page)).filter((c) => c.method === 'createPrefix')).toEqual([]);

  await name.fill('  Celeste ');
  await name.press('Enter');
  await expect(page.getByText('/home/jane/.local/share/dune/prefixes/Celeste')).toBeVisible();
  expect((await stubCalls(page)).filter((c) => c.method === 'createPrefix')).toEqual([{ method: 'createPrefix', args: ['Celeste'] }]);
  await expect(name).toHaveValue('');
});

test('create failure codes become plain inline messages', async ({ page }) => {
  await installElectronStub(page, { prefixes, prefixFail: { create: 'invalid-name' } });
  await openPrefixes(page);
  await page.getByLabel('Prefix name').fill('bad name!');
  await page.getByRole('button', { name: 'Create Prefix' }).click();
  const error = page.locator('#new-prefix-error');
  await expect(error).toContainText('letters, numbers');
  await expect(error).not.toContainText('invalid-name');
});

test('delete asks in a dialog with name, path and Trash note, then deletes by id', async ({ page }) => {
  await installElectronStub(page, { prefixes });
  await openPrefixes(page);
  const trigger = page.getByRole('button', { name: 'Delete Hades' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Delete this prefix?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Hades');
  await expect(dialog).toContainText(prefixes[0].path);
  await expect(dialog).toContainText('Moves the folder to the Trash.');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expectNoSeriousViolations(page, 'prefix delete dialog');

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect((await stubCalls(page)).filter((c) => c.method === 'deletePrefix')).toEqual([]);

  await trigger.click();
  await dialog.getByRole('button', { name: 'Move to Trash' }).click();
  await expect(page.getByRole('button', { name: 'Delete Hades' })).toHaveCount(0);
  expect((await stubCalls(page)).filter((c) => c.method === 'deletePrefix')).toEqual([{ method: 'deletePrefix', args: ['p-hades'] }]);
});

test('delete and backup failures show inline row messages', async ({ page }) => {
  await installElectronStub(page, { prefixes, prefixFail: { delete: 'trash-failed', backup: 'symlink' } });
  await openPrefixes(page);
  await page.getByRole('button', { name: 'Delete Hades' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Move to Trash' }).click();
  const row = page.locator('.prefix-list li').filter({ hasText: 'Hades' });
  await expect(row.getByRole('alert')).toHaveText('Could not move the folder to the Trash. Nothing was deleted.');

  await row.getByRole('button', { name: 'Backup Hades' }).click();
  await expect(row.getByRole('alert')).toContainText('is a link');
  await expect(row).not.toContainText('symlink');
  expect((await stubCalls(page)).filter((c) => c.method === 'backupPrefix')).toEqual([{ method: 'backupPrefix', args: ['p-hades'] }]);
});

test('launch failures (DUN-061) show plain wording, not codes', async ({ page }) => {
  await installElectronStub(page, { games: sampleGames.slice(0, 1), launchFail: { reason: 'not-launchable' } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Launch', exact: true }).first().click();
  const toast = page.locator('.toast-error');
  await expect(toast).toContainText("Dune doesn't know how to start Hades yet.");
  await expect(toast).not.toContainText('not-launchable');
  expect((await stubCalls(page)).filter((c) => c.method === 'launchGame')).toEqual([{ method: 'launchGame', args: [1] }]);
});
