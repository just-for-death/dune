import { test, expect } from '@playwright/test';
import { expectNoSeriousViolations } from './axe';
import { installElectronStub, searchGames } from './stub';

const titles = (page: import('@playwright/test').Page) => page.locator('.games-grid .game-title');

test.beforeEach(async ({ page }) => {
  await installElectronStub(page, { games: searchGames });
  await page.goto('/');
  await expect(titles(page)).toHaveCount(searchGames.length);
});

test('search box has an accessible label and a polite result count', async ({ page }) => {
  const search = page.getByRole('textbox', { name: 'Search games' });
  await expect(search).toBeVisible();
  const count = page.locator('#library-search-count');
  await expect(count).toHaveAttribute('role', 'status');
  await expect(count).toHaveAttribute('aria-live', 'polite');
  await expect(count).toHaveText('');
  await search.fill('hades');
  await expect(titles(page)).toHaveText(['Hades', 'Hades II']);
  await expect(count).toHaveText('2 of 6 games match');
});

test('matching ignores case and diacritics', async ({ page }) => {
  const search = page.getByRole('textbox', { name: 'Search games' });
  await search.fill('POKEMON legendes');
  await expect(titles(page)).toHaveText(['Pokémon Légendes: Arceus']);
  await search.fill('okami');
  await expect(titles(page)).toHaveText(['Ōkami HD']);
  await search.fill('pokémon');
  await expect(titles(page)).toHaveText(['Pokémon Légendes: Arceus']);
});

test('typing character by character filters by tags and sources', async ({ page }) => {
  const search = page.getByRole('textbox', { name: 'Search games' });
  await search.pressSequentially('metroid', { delay: 20 });
  await expect(titles(page)).toHaveText(['Hollow Knight']);
  await search.fill('heroic');
  await expect(titles(page)).toHaveText(['Celeste']);
  await expect(page.locator('#library-search-count')).toHaveText('1 of 6 games match');
});

test('no match shows an empty state; Escape clears the box', async ({ page }) => {
  const search = page.getByRole('textbox', { name: 'Search games' });
  await search.fill('zelda');
  await expect(titles(page)).toHaveCount(0);
  await expect(page.locator('.empty-state')).toContainText('No games match "zelda"');
  await expect(page.locator('#library-search-count')).toHaveText('0 of 6 games match');
  await expectNoSeriousViolations(page, 'search-empty');

  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  await expect(titles(page)).toHaveCount(searchGames.length);
  await expect(page.locator('#library-search-count')).toHaveText('');
});
