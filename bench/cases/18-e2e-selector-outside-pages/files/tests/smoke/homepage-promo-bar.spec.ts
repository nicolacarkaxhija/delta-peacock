import { expect, test } from '../../support/fixtures.js';

test('The promo bar renders above the header', { tag: ['@homepage'] }, async ({ home, page }) => {
  await home.open();
  await expect(page.locator('.l-header-bottom_promo'), 'the promo bar renders on every page').toBeVisible();
});
