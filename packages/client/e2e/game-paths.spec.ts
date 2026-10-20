import { test, expect, type Locator, type Page } from '@playwright/test';
import { expectNoSeriousViolations } from './axe';
import { installElectronStub, pathGames } from './stub';

const card = (page: Page, name: string) => page.locator('.game-card').filter({ has: page.locator('.game-title', { hasText: name }) });
const row = (page: Page, name: string) => page.locator('.path-row').filter({ has: page.locator('strong', { hasText: name }) });

/** Fails if any descendant paints wider than its container or the element overflows the viewport. */
async function expectNoOverflow(scope: Locator) {
  const problems = await scope.evaluate((root) => {
    const out: string[] = [];
    const vw = document.documentElement.clientWidth;
    const rootBox = root.getBoundingClientRect();
    if (rootBox.right > vw + 1) out.push(`root exceeds viewport by ${rootBox.right - vw}px`);
    for (const el of [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))]) {
      const box = el.getBoundingClientRect();
      if (box.width === 0) continue;
      if (box.right > rootBox.right + 1 || box.left < rootBox.left - 1) {
        out.push(`${el.tagName.toLowerCase()}.${el.className} sticks out of ${root.className}`);
      }
      const style = getComputedStyle(el);
      if (style.overflowX === 'visible' && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
        out.push(`${el.tagName.toLowerCase()}.${el.className} scrollWidth ${el.scrollWidth} > ${el.clientWidth}`);
      }
    }
    return out;
  });
  expect(problems).toEqual([]);
}

test.describe('game paths on the library cards', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await installElectronStub(page, { games: pathGames });
    await page.goto('/');
    await expect(page.locator('.game-card')).toHaveCount(pathGames.length);
  });

  test('both paths, no save folder, no install folder', async ({ page }) => {
    const hades = card(page, 'Hades');
    await expect(hades.locator('dt')).toHaveText(['Save path', 'Install folder']);
    await expect(hades.locator('.path-value').first()).toHaveAttribute('title', pathGames[0].linPath!);
    await expect(hades.locator('.path-value').nth(1)).toHaveText(pathGames[0].installPath!);

    const celeste = card(page, 'Celeste');
    await expect(celeste.locator('.path-missing')).toHaveText('No save folder found');
    await expect(celeste.locator('dt')).toHaveText(['Save path', 'Install folder']);

    const manual = card(page, 'My Homebrew Game');
    await expect(manual.locator('dt')).toHaveText(['Save path']);
    await expect(manual.getByText('Install folder')).toHaveCount(0);

    // winPath is used when linPath is empty.
    await expect(card(page, 'Disco Elysium').locator('.path-value').first()).toHaveAttribute('title', pathGames[3].winPath!);
  });

  test('source badges have readable text', async ({ page }) => {
    const expected: Record<string, string> = {
      Hades: 'Steam',
      Celeste: 'Heroic',
      'My Homebrew Game': 'Manual',
      'Disco Elysium': 'External',
      'Stardew Valley': 'Lutris',
    };
    for (const [name, label] of Object.entries(expected)) {
      const badge = card(page, name).locator('.source-badge');
      await expect(badge).toHaveText(`Source: ${label}`);
      await expect(badge).toBeVisible();
    }
    await expect(card(page, 'Disco Elysium').locator('.source-badge')).toHaveAttribute('title', /GOG/);
  });

  test('long paths do not overflow and stay copyable', async ({ page }) => {
    for (const name of ['Hades', 'Disco Elysium', 'Stardew Valley']) {
      await expectNoOverflow(card(page, name));
    }
    const value = card(page, 'Disco Elysium').locator('.path-value').first();
    expect(await value.evaluate((el) => getComputedStyle(el).userSelect)).toBe('text');
    // Selecting the clamped element yields the full path.
    const selected = await value.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      return sel.toString();
    });
    expect(selected).toBe(pathGames[3].winPath);
  });

  test('narrow viewport: still no overflow', async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 900 });
    for (const name of ['Hades', 'Disco Elysium']) {
      await expectNoOverflow(card(page, name));
    }
  });

  test('axe: library with path variants', async ({ page }) => {
    await expectNoSeriousViolations(page, 'library-paths');
  });

  test('visual: cards for each path variant', async ({ page }) => {
    test.skip(process.platform !== 'linux', 'Screenshot baselines are Linux-only (chromium-linux).');
    for (const [name, file] of [
      ['Hades', 'card-both-paths.png'],
      ['Celeste', 'card-no-save-folder.png'],
      ['My Homebrew Game', 'card-no-install-folder.png'],
      ['Disco Elysium', 'card-long-paths.png'],
    ] as const) {
      await expect(card(page, name)).toHaveScreenshot(file, { maxDiffPixelRatio: 0.01 });
    }
  });
});

test.describe('game paths in the Game Paths tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await installElectronStub(page, { games: pathGames });
    await page.goto('/');
    await page.getByRole('button', { name: 'Game Paths', exact: true }).click();
  });

  test('form asks for save folders', async ({ page }) => {
    await expect(page.getByLabel('Windows save folder')).toBeVisible();
    await expect(page.getByLabel('Linux save folder')).toBeVisible();
    await expect(page.getByLabel('Linux save folder')).toHaveAccessibleDescription(/not where it is installed/);
  });

  test('tracked list shows save/install rows and badges without overflow', async ({ page }) => {
    await expect(row(page, 'Celeste').locator('.path-missing')).toHaveText('No save folder found');
    await expect(row(page, 'My Homebrew Game').locator('dt')).toHaveText(['Save path']);
    await expect(row(page, 'Hades').locator('dt')).toHaveText(['Save path', 'Install folder']);
    await expect(row(page, 'Hades').locator('.source-badge')).toHaveText('Source: Steam');
    for (const name of ['Disco Elysium', 'Stardew Valley']) {
      await expectNoOverflow(row(page, name));
    }
  });

  test('axe: Game Paths tab with path variants', async ({ page }) => {
    await expectNoSeriousViolations(page, 'game-paths-variants');
  });

  test('visual: tracked games list', async ({ page }) => {
    test.skip(process.platform !== 'linux', 'Screenshot baselines are Linux-only (chromium-linux).');
    // The list grew with per-game launch settings; make the viewport tall enough that the
    // element screenshot is never clipped by the scrolling main pane.
    await page.setViewportSize({ width: 1280, height: 1600 });
    const tracked = page.locator('.card').filter({ has: page.getByRole('heading', { name: /^Tracked Games/ }) }).locator('> .path-list');
    await expect(tracked).toHaveCount(1);
    await expect(tracked).toHaveScreenshot('tracked-games-list.png', { maxDiffPixelRatio: 0.01 });
  });
});
