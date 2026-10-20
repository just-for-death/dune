import { test, expect } from '@playwright/test';
import { installElectronStub } from './stub';

test('a failed save shows an error toast and keeps the draft with an inline error', async ({ page }) => {
  await installElectronStub(page, { failSaveConfig: 1 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const url = page.locator('#server-url');
  await url.fill('http://192.168.1.10:3030');
  await url.blur();
  await expect(page.locator('.toast-error')).toContainText('Failed to save the server address');
  await expect(page.locator('#server-url-error')).toContainText('Not saved');
  await expect(url).toHaveValue('http://192.168.1.10:3030');

  // Retrying (the next save succeeds) clears the error.
  await url.fill('http://192.168.1.11:3030');
  await url.blur();
  await expect(page.locator('#server-url-error')).toHaveCount(0);
  await expect(url).toHaveValue('http://192.168.1.11:3030');
});
