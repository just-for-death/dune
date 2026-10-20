import { test, expect, type Locator, type Page } from '@playwright/test';
import { installElectronStub, sampleConflict, sampleGames, stubCalls } from './stub';

// launchGame(gameId) is called with the game's id (DUN-061).
const CELESTE_ID = sampleGames.find((g) => g.name === 'Celeste')!.id;

/** True when the element matches :focus-visible and paints a non-zero outline or ring. */
async function hasVisibleFocus(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => {
    const style = getComputedStyle(el);
    const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
    const ring = style.boxShadow !== 'none';
    return el.matches(':focus-visible') && (outline || ring);
  });
}

async function tabUntilFocused(page: Page, target: Locator, maxTabs = 40) {
  for (let i = 0; i < maxTabs; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('target never received focus via Tab');
}

test.describe('keyboard: navigation', () => {
  test('Tab reaches every nav item with a visible focus indicator', async ({ page }) => {
    await installElectronStub(page);
    await page.goto('/');
    const navItems = page.locator('.sidebar .nav-item');
    const count = await navItems.count();
    expect(count).toBeGreaterThanOrEqual(10);
    await page.keyboard.press('Tab');
    for (let i = 0; i < count; i++) {
      const item = navItems.nth(i);
      await expect(item).toBeFocused();
      expect(await hasVisibleFocus(item), `nav item ${i} focus visible`).toBe(true);
      await page.keyboard.press('Tab');
    }
  });

  test('text inputs and checkboxes show a visible focus style', async ({ page }) => {
    await installElectronStub(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const urlInput = page.locator('#server-url');
    await tabUntilFocused(page, urlInput);
    const ring = await urlInput.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(ring).not.toBe('none');
    const checkbox = page.getByRole('checkbox', { name: /Run in background/ });
    await page.getByRole('heading', { name: 'Application Settings' }).click();
    await tabUntilFocused(page, checkbox);
    expect(await hasVisibleFocus(checkbox)).toBe(true);
  });

  test('toasts live in polite/alert regions and can be dismissed', async ({ page }) => {
    await installElectronStub(page);
    await page.goto('/');
    await expect(page.locator('.toast-container [role="status"][aria-live="polite"]')).toHaveCount(1);
    await expect(page.locator('.toast-container [role="alert"]')).toHaveCount(1);
    await page.getByRole('button', { name: 'Game Paths', exact: true }).click();
    await page.locator('#new-game-title').fill('Hades');
    await page.getByRole('button', { name: 'Save Mapping' }).click();
    const toast = page.locator('[role="alert"] .toast-error');
    await expect(toast).toContainText('At least one save path is required');
    // Errors persist longer than the 4s info timeout.
    await page.waitForTimeout(4500);
    await expect(toast).toBeVisible();
    await toast.getByRole('button', { name: 'Dismiss notification' }).click();
    await expect(toast).toHaveCount(0);
  });
});

test.describe('keyboard: conflict modal', () => {
  test('opens with focus on the first action, traps Tab, Escape defers and restores focus', async ({ page }) => {
    await installElectronStub(page, { games: sampleGames.slice(0, 2), ...sampleConflict });
    await page.goto('/');
    const savesNav = page.getByRole('button', { name: 'Saves', exact: true });
    await tabUntilFocused(page, savesNav);
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog', { name: 'Save conflict detected' });
    await expect(dialog).toBeVisible();
    const keepLocal = dialog.getByRole('button', { name: 'Keep local copy' });
    await expect(keepLocal).toBeFocused();
    await expect(dialog.getByRole('button', { name: 'Keep server copy' })).toBeVisible();
    await expect(dialog).toContainText('6.6 MB');

    // Focus trap: Tab past the last action wraps to the first, Shift+Tab back.
    const actions = dialog.getByRole('button');
    const actionCount = await actions.count();
    for (let i = 0; i < actionCount; i++) {
      await page.keyboard.press('Tab');
      const inside = await dialog.evaluate((el) => el.contains(document.activeElement));
      expect(inside, `focus stays in dialog after Tab #${i + 1}`).toBe(true);
    }
    await expect(keepLocal).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(actions.last()).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(savesNav).toBeFocused();
    expect(await stubCalls(page)).toContainEqual({ method: 'resolveConflict', args: ['c1', 'later'] });

    // Not auto-reopened on the next visit; the banner offers it instead.
    await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
    await savesNav.click();
    const review = page.getByRole('button', { name: 'Review conflict' });
    await expect(review).toBeVisible();
    await page.waitForTimeout(300);
    await expect(dialog).toBeHidden();

    // Opening from the banner returns focus there on close.
    await review.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(keepLocal).toBeFocused();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
    await expect(review).toBeFocused();
  });

  test('dialog fits the viewport and scrolls internally', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 420 });
    await installElectronStub(page, { games: sampleGames.slice(0, 1), ...sampleConflict });
    await page.goto('/');
    await page.getByRole('button', { name: 'Saves', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Save conflict detected' });
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box!.height).toBeLessThanOrEqual(420 * 0.9 + 1);
    expect(await dialog.evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto');
  });
});

test.describe('keyboard: Big Picture', () => {
  test('autofocuses the first card and moves with arrow keys; Enter launches', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installElectronStub(page, { games: sampleGames });
    await page.goto('/');
    await page.getByRole('button', { name: 'Big Picture', exact: true }).click();
    const cards = page.locator('.big-picture-card');
    await expect(cards).toHaveCount(sampleGames.length);
    await expect(cards.nth(0)).toBeFocused();

    const columns = await page.locator('.big-picture-grid').evaluate(
      (el) => getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length,
    );
    expect(columns).toBeGreaterThan(1);

    await page.keyboard.press('ArrowRight');
    await expect(cards.nth(1)).toBeFocused();
    expect(await hasVisibleFocus(cards.nth(1))).toBe(true);
    await page.keyboard.press('ArrowLeft');
    await expect(cards.nth(0)).toBeFocused();
    await page.keyboard.press('ArrowLeft'); // stays at the edge
    await expect(cards.nth(0)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(cards.nth(columns)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(cards.nth(0)).toBeFocused();
    await page.keyboard.press('End');
    await expect(cards.nth(sampleGames.length - 1)).toBeFocused();
    await page.keyboard.press('Home');
    await expect(cards.nth(0)).toBeFocused();

    // Roving tabindex: exactly one card is in the Tab order.
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.big-picture-card[tabindex="0"]')).toHaveCount(1);
    await expect(cards.nth(1)).toHaveAttribute('tabindex', '0');

    await page.keyboard.press('Enter');
    await expect(page.locator('.toast-success').filter({ hasText: 'Launched Celeste' })).toBeVisible();
    expect(await stubCalls(page)).toContainEqual({ method: 'launchGame', args: [CELESTE_ID] });
  });

  test('gamepad d-pad moves focus and A launches', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installElectronStub(page, { games: sampleGames });
    // Fake a standard-mapping pad that the test can drive.
    await page.addInitScript(() => {
      const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
      const pad = { id: 'e2e pad', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons, timestamp: 0 };
      (window as unknown as { __pad: typeof pad }).__pad = pad;
      Object.defineProperty(navigator, 'getGamepads', { value: () => [pad, null, null, null] });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Big Picture', exact: true }).click();
    const cards = page.locator('.big-picture-card');
    await expect(cards.nth(0)).toBeFocused();

    // Hold a button until its effect is observed, then release (robust to slow rAF under load).
    const setButton = (button: number, pressed: boolean) =>
      page.evaluate(([b, p]) => {
        (window as unknown as { __pad: { buttons: { pressed: boolean }[] } }).__pad.buttons[b as number].pressed = p as boolean;
      }, [button, pressed]);
    await setButton(15, true); // d-pad right
    await expect(cards.nth(1)).toBeFocused();
    await setButton(15, false);
    await setButton(0, true); // A
    await expect(page.locator('.toast-success').filter({ hasText: 'Launched Celeste' })).toBeVisible();
    await setButton(0, false);
    // A (rising edge) launched the focused card exactly once.
    expect((await stubCalls(page)).filter((c) => c.method === 'launchGame')).toEqual([{ method: 'launchGame', args: [CELESTE_ID] }]);
  });

  test('long titles clamp to two lines without overflowing the card', async ({ page }) => {
    await installElectronStub(page, { games: sampleGames });
    await page.goto('/');
    await page.getByRole('button', { name: 'Big Picture', exact: true }).click();
    const title = page.locator('.big-picture-title').nth(3);
    const { lines, overflowX } = await title.evaluate((el) => {
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 21;
      const card = el.closest('.big-picture-card')!;
      return { lines: Math.round(el.getBoundingClientRect().height / lh), overflowX: card.scrollWidth > card.clientWidth };
    });
    expect(lines).toBeLessThanOrEqual(2);
    expect(overflowX).toBe(false);
  });
});
