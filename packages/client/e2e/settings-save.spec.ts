import { test, expect, type Page } from '@playwright/test';
import { installElectronStub, stubCalls } from './stub';

/** DUN-045: Settings fields save after typing stops / on blur, validated, one at a time. */
const cloudSaves = async (page: Page) =>
  (await stubCalls(page)).filter((c) => c.method === 'saveConfig' && (c.args[0] as Record<string, unknown>).cloud);

test.beforeEach(async ({ page }) => {
  await installElectronStub(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
});

test('typing a URL letter by letter saves once, with the final valid value', async ({ page }) => {
  const url = page.locator('#server-url');
  await url.pressSequentially('http://192.168.1.10:3030', { delay: 40 });
  // Draft is visible immediately but not saved while typing.
  await expect(url).toHaveValue('http://192.168.1.10:3030');
  expect(await cloudSaves(page)).toEqual([]);
  await expect.poll(async () => (await cloudSaves(page)).length, { timeout: 3000 }).toBe(1);
  await page.waitForTimeout(800);
  const saves = await cloudSaves(page);
  expect(saves).toHaveLength(1);
  expect(saves[0].args[0]).toEqual({ cloud: { url: 'http://192.168.1.10:3030' } });
});

test('invalid drafts show an inline error and are never saved', async ({ page }) => {
  const url = page.locator('#server-url');
  for (const bad of ['192.168.1.100:3030', 'h', 'http://user:pw@host', 'http://host/?q=1']) {
    await url.fill(bad);
    await url.blur();
    const error = page.locator('#server-url-error');
    await expect(error).toBeVisible();
    await expect(url).toHaveAttribute('aria-invalid', 'true');
    await expect(url).toHaveAttribute('aria-describedby', 'server-url-error');
    await expect(url).toHaveValue(bad); // draft stays visible
  }
  await page.waitForTimeout(700);
  expect(await cloudSaves(page)).toEqual([]);

  await url.fill('http://192.168.1.10:3030');
  await url.blur();
  await expect(page.locator('#server-url-error')).toHaveCount(0);
  await expect.poll(async () => (await cloudSaves(page)).length).toBe(1);
});

test('blur saves immediately; quick toggles are not lost', async ({ page }) => {
  const url = page.locator('#server-url');
  await url.fill('https://dune.example.org/');
  await page.getByRole('heading', { name: 'Application Settings' }).click(); // blur
  await expect.poll(async () => (await cloudSaves(page)).map((c) => c.args[0])).toEqual([{ cloud: { url: 'https://dune.example.org' } }]);

  await page.getByRole('checkbox', { name: /Run in background/ }).check();
  await page.getByRole('checkbox', { name: /Enable automatic background sync/ }).check();
  await expect.poll(async () => {
    const last = (await stubCalls(page)).filter((c) => c.method === 'saveConfig' && (c.args[0] as Record<string, unknown>).settings).at(-1);
    const settings = (last?.args[0] as { settings?: Record<string, unknown> } | undefined)?.settings;
    return settings ? [settings.runInBackground, settings.autoSyncEnabled] : null;
  }).toEqual([true, true]);
});

test('server key saves once after typing and never appears in calls or toasts', async ({ page }) => {
  const key = page.locator('#server-api-key');
  await key.pressSequentially('secret-key-123', { delay: 30 });
  await expect.poll(async () => (await stubCalls(page)).filter((c) => c.method === 'setServerKey').length, { timeout: 3000 }).toBe(1);
  await page.waitForTimeout(700);
  expect((await stubCalls(page)).filter((c) => c.method === 'setServerKey')).toHaveLength(1);
  await expect(page.locator('.toast-container')).not.toContainText('secret-key-123');
});
