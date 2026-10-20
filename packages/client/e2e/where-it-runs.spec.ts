import { test, expect, type Page } from '@playwright/test';
import { installElectronStub, stubCalls, type StubOptions } from './stub';
import { expectNoSeriousViolations } from './axe';

/** DUN-032: Sources, Servers and API keys under "Where it runs". */
const seeded: StubOptions = {
  cloudUrl: 'http://192.168.1.10:3030',
  server: {
    sources: [
      { id: 1, path: '/srv/dune/saves' },
      { id: 2, path: `/srv/dune/${'a-really-long-folder-name-without-spaces-'.repeat(4)}end` },
    ],
    servers: [{ id: 3, url: 'http://192.168.1.20:3030' }],
    keys: [
      { id: 'abc123def456', description: 'Steam Deck', createdAt: '2026-09-01T10:00:00.000Z', masked: '****' },
      { id: 'fff000eee111', description: '', createdAt: '2026-09-02T10:00:00.000Z', masked: '****' },
    ],
  },
};

const section = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

async function openSettings(page: Page, options: StubOptions) {
  await installElectronStub(page, options);
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Where it runs' })).toBeVisible();
}

const methods = async (page: Page, method: string) => (await stubCalls(page)).filter((c) => c.method === method);

test.describe('no server configured', () => {
  test('each section says to connect a server, link focuses the address field', async ({ page }) => {
    await openSettings(page, {});
    for (const name of ['Sources', 'Servers']) {
      await expect(section(page, name)).toContainText('Connect a Dune server to manage this');
    }
    await expect(section(page, 'API keys')).toContainText('Connect a Dune server to manage this');
    // This PC's key is local, so its row still shows.
    await expect(section(page, 'API keys')).toContainText('Dune server key');
    await section(page, 'Sources').getByRole('link', { name: 'Set the server address' }).click();
    await expect(page.locator('#server-url')).toBeFocused();
    expect(await methods(page, 'addLocalSource')).toEqual([]);
    await expectNoSeriousViolations(page, 'where-it-runs (no server)', '.where-it-runs');
  });

  test('saving a server address loads the lists', async ({ page }) => {
    await openSettings(page, { server: seeded.server });
    await page.locator('#server-url').fill('http://192.168.1.10:3030');
    await page.locator('#server-url').blur();
    await expect(section(page, 'Sources').getByText('/srv/dune/saves')).toBeVisible();
  });
});

test.describe('Sources', () => {
  test('lists, validates, adds and removes with confirmation', async ({ page }) => {
    await openSettings(page, seeded);
    const sources = section(page, 'Sources');
    await expect(sources.getByText('/srv/dune/saves')).toBeVisible();
    await expect(sources.getByRole('status')).toHaveText('2 sources');
    // No enable/disable toggle exists.
    await expect(sources.getByRole('checkbox')).toHaveCount(0);
    await expect(sources.getByRole('switch')).toHaveCount(0);

    const input = sources.getByLabel('Folder path on the server');
    await input.fill('games/saves');
    await sources.getByRole('button', { name: 'Add source' }).click();
    await expect(sources.getByRole('alert')).toContainText('Use a full path');
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(await methods(page, 'addLocalSource')).toEqual([]);

    await input.fill('/srv/The Witcher 3: Wild Hunt™/');
    await input.press('Enter');
    await expect(sources.getByText('/srv/The Witcher 3: Wild Hunt™', { exact: true })).toBeVisible();
    await expect(sources.getByRole('status')).toHaveText('Source added.');
    expect(await methods(page, 'addLocalSource')).toEqual([{ method: 'addLocalSource', args: ['/srv/The Witcher 3: Wild Hunt™'] }]);
    await expect(input).toHaveValue('');

    const remove = sources.getByRole('button', { name: 'Remove source /srv/dune/saves' });
    await remove.click();
    const dialog = page.getByRole('dialog', { name: 'Remove this source?' });
    await expect(dialog).toContainText('/srv/dune/saves');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(remove).toBeFocused();
    expect(await methods(page, 'removeLocalSource')).toEqual([]);

    await remove.click();
    await dialog.getByRole('button', { name: 'Remove source' }).click();
    await expect(sources.getByText('/srv/dune/saves', { exact: true })).toHaveCount(0);
    expect(await methods(page, 'removeLocalSource')).toEqual([{ method: 'removeLocalSource', args: [1] }]);
    await expect(sources.getByRole('heading', { name: 'Sources' })).toBeFocused();
  });

  test('a path the server rejects shows a plain inline error', async ({ page }) => {
    await openSettings(page, seeded);
    const sources = section(page, 'Sources');
    await sources.getByLabel('Folder path on the server').fill('/srv/missing');
    await sources.getByRole('button', { name: 'Add source' }).click();
    await expect(sources.getByRole('alert')).toContainText('Check that the folder exists on the server');
  });
});

test.describe('Servers', () => {
  test('shows Not tested, a disabled Test with reason, adds and removes', async ({ page }) => {
    await openSettings(page, seeded);
    const servers = section(page, 'Servers');
    await expect(servers).toContainText('Status: Not tested');
    const testBtn = servers.getByRole('button', { name: 'Test http://192.168.1.20:3030' });
    await expect(testBtn).toBeDisabled();
    await expect(testBtn).toHaveAccessibleDescription('Test: Not available yet');

    const input = servers.getByLabel('Server address');
    for (const bad of ['192.168.1.100:3030', 'http://user:pw@host', 'http://192.168.1.20:3030/']) {
      await input.fill(bad);
      await input.press('Enter');
      await expect(servers.getByRole('alert')).toBeVisible();
    }
    await expect(servers.getByRole('alert')).toHaveText('This server is already listed.');
    expect(await methods(page, 'addRemoteServer')).toEqual([]);

    await input.fill('https://backup.example.org/');
    await input.press('Enter');
    await expect(servers.getByText('https://backup.example.org', { exact: true })).toBeVisible();
    expect(await methods(page, 'addRemoteServer')).toEqual([{ method: 'addRemoteServer', args: ['https://backup.example.org'] }]);

    await servers.getByRole('button', { name: 'Remove server http://192.168.1.20:3030' }).click();
    await page.getByRole('dialog', { name: 'Remove this server?' }).getByRole('button', { name: 'Remove server' }).click();
    await expect(servers.getByText('http://192.168.1.20:3030', { exact: true })).toHaveCount(0);
    expect(await methods(page, 'removeRemoteServer')).toEqual([{ method: 'removeRemoteServer', args: [3] }]);
  });
});

test.describe('admin-only actions', () => {
  test('403 shows "Needs an admin key" inline, never as a toast', async ({ page }) => {
    await openSettings(page, { ...seeded, server: { ...seeded.server, admin: false } });
    const sources = section(page, 'Sources');
    await sources.getByLabel('Folder path on the server').fill('/srv/new');
    await sources.getByRole('button', { name: 'Add source' }).click();
    await expect(sources.getByRole('alert')).toHaveText('Needs an admin key');

    await sources.getByRole('button', { name: 'Remove source /srv/dune/saves' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove source' }).click();
    await expect(sources.locator('li').filter({ hasText: '/srv/dune/saves' }).getByRole('alert')).toHaveText('Needs an admin key');

    const servers = section(page, 'Servers');
    await servers.getByLabel('Server address').fill('http://10.0.0.5:3030');
    await servers.getByRole('button', { name: 'Add server' }).click();
    await expect(servers.getByRole('alert')).toHaveText('Needs an admin key');
    await expect(page.locator('.toast')).toHaveCount(0);
  });

  test('a rejected key on load shows one inline error per list with Try again', async ({ page }) => {
    await openSettings(page, { ...seeded, server: { ...seeded.server, failLoad: { status: 403, code: 'INVALID_API_KEY', message: 'Invalid API key' } } });
    for (const name of ['Sources', 'Servers', 'API keys']) {
      await expect(section(page, name).getByRole('alert')).toContainText("The server rejected this PC's key.");
      await expect(section(page, name).getByRole('button', { name: 'Try again' })).toBeVisible();
    }
    await expect(page.locator('.toast')).toHaveCount(0);
  });
});

test.describe('API keys', () => {
  test('this PC: Set/Not set only; providers disabled with a reason', async ({ page }) => {
    await openSettings(page, seeded);
    const keys = section(page, 'API keys');
    await expect(keys.getByRole('heading', { name: 'On this PC' })).toBeVisible();
    await expect(keys.getByRole('heading', { name: 'On your Dune server' })).toBeVisible();
    await expect(keys).toContainText('Set');
    await expect(page.locator('body')).not.toContainText('e2e-key');
    await expect(page.locator('#server-api-key')).toHaveValue('');
    for (const provider of ['SteamGridDB', 'Achievement tracker']) {
      const btn = keys.getByRole('button', { name: `Set key for ${provider}` });
      await expect(btn).toBeDisabled();
      await expect(btn).toHaveAccessibleDescription(/Coming with provider settings/);
    }
    await keys.getByRole('link', { name: 'Change' }).click();
    await expect(page.locator('#server-api-key')).toBeFocused();
  });

  test('issues a key shown once, never in toasts, and revokes with confirmation', async ({ page }) => {
    await openSettings(page, seeded);
    const keys = section(page, 'API keys');
    await expect(keys.getByText('Steam Deck')).toBeVisible();
    await expect(keys.getByText('Unnamed key')).toBeVisible();

    await keys.getByLabel('Name for a new key (optional)').fill('Living room PC');
    await keys.getByRole('button', { name: 'Issue key' }).click();
    const issued = keys.getByLabel('New key', { exact: true });
    await expect(issued).toHaveValue(/^dune_e2e_issued_1_/);
    await expect(issued).toBeFocused();
    await expect(keys.getByRole('status')).toHaveText('Key issued. Copy it now; it will not be shown again.');
    await expect(page.locator('.toast-container')).not.toContainText('dune_e2e_issued');
    expect(await methods(page, 'addApiKey')).toEqual([{ method: 'addApiKey', args: ['Living room PC'] }]);
    await expect(keys.getByText('Living room PC')).toBeVisible();

    await keys.getByRole('button', { name: 'Done' }).click();
    await expect(keys.getByLabel('New key', { exact: true })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('dune_e2e_issued');

    await keys.getByRole('button', { name: 'Revoke key Steam Deck' }).click();
    const dialog = page.getByRole('dialog', { name: 'Revoke this key?' });
    await expect(dialog).toContainText('Steam Deck');
    await dialog.getByRole('button', { name: 'Revoke key' }).click();
    await expect(keys.getByText('Steam Deck')).toHaveCount(0);
    expect(await methods(page, 'removeApiKey')).toEqual([{ method: 'removeApiKey', args: ['abc123def456'] }]);
  });

  test('set and clear this PC\'s key', async ({ page }) => {
    await openSettings(page, { ...seeded, serverKey: '' });
    const status = page.locator('#server-api-key-status');
    await expect(status).toHaveText('Key on this PC: Not set');
    const input = page.locator('#server-api-key');
    await expect(input).toHaveAttribute('type', 'text');
    await expect(input).toHaveAttribute('autocomplete', 'off');
    await input.fill('pasted-key-789');
    await input.blur();
    await expect(status).toHaveText('Key on this PC: Set');
    await expect(input).toHaveValue('');
    await expect(page.locator('body')).not.toContainText('pasted-key-789');

    await page.getByRole('button', { name: 'Clear key' }).click();
    const dialog = page.getByRole('dialog', { name: "Clear this PC's server key?" });
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Clear key' }).click();
    await expect(status).toHaveText('Key on this PC: Not set');
    expect((await methods(page, 'setServerKey')).map((c) => c.args)).toEqual([[], ['<cleared>']]);
  });

  test('emptying the key field never clears the key', async ({ page }) => {
    await openSettings(page, seeded);
    const input = page.locator('#server-api-key');
    await input.fill('x');
    await input.fill('');
    await input.blur();
    await page.waitForTimeout(700);
    expect(await methods(page, 'setServerKey')).toEqual([]);
    await expect(page.locator('#server-api-key-status')).toHaveText('Key on this PC: Set');
  });
});

test.describe('accessibility and layout', () => {
  test('axe: each section and each confirm dialog', async ({ page }) => {
    await openSettings(page, seeded);
    await expect(section(page, 'API keys').getByText('Steam Deck')).toBeVisible();
    await expectNoSeriousViolations(page, 'where-it-runs', '.where-it-runs');
    await expectNoSeriousViolations(page, 'server key field', '#server-api-key-status');

    await section(page, 'Sources').getByRole('button', { name: 'Remove source /srv/dune/saves' }).click();
    await expectNoSeriousViolations(page, 'remove source dialog');
    await page.keyboard.press('Escape');

    await section(page, 'API keys').getByRole('button', { name: 'Issue key' }).click();
    await expect(section(page, 'API keys').getByLabel('New key', { exact: true })).toBeVisible();
    await expectNoSeriousViolations(page, 'issued key', '.where-it-runs');
  });

  test('keyboard: confirm dialog traps Tab, Escape restores focus', async ({ page }) => {
    await openSettings(page, seeded);
    const remove = section(page, 'Servers').getByRole('button', { name: 'Remove server http://192.168.1.20:3030' });
    await remove.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Remove this server?' });
    const cancel = dialog.getByRole('button', { name: 'Cancel' });
    const confirm = dialog.getByRole('button', { name: 'Remove server' });
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(confirm).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(confirm).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(remove).toBeFocused();
    expect(await methods(page, 'removeRemoteServer')).toEqual([]);
  });

  for (const width of [1280, 600]) {
    test(`no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openSettings(page, seeded);
      await expect(section(page, 'Sources').getByText('/srv/dune/saves')).toBeVisible();
      const overflows = await page.locator('.where-it-runs, .where-it-runs .admin-row').evaluateAll((els) =>
        els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.className));
      expect(overflows).toEqual([]);
    });
  }

  test('visual: Where it runs', async ({ page }) => {
    test.skip(process.platform !== 'linux', 'Screenshot baselines are generated on Linux only');
    // Tall enough that the whole block fits without the main pane scrolling.
    await page.setViewportSize({ width: 1280, height: 3200 });
    await openSettings(page, seeded);
    await expect(section(page, 'API keys').getByText('Steam Deck')).toBeVisible();
    await page.locator('.where-it-runs').scrollIntoViewIfNeeded();
    await expect(page.locator('.where-it-runs')).toHaveScreenshot('where-it-runs.png', { animations: 'disabled' });
  });
});
