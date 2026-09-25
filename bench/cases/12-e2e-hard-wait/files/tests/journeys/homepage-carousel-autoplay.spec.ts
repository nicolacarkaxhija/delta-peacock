import { expect, test } from '../../support/fixtures.js';

test('The hero carousel advances to a second slide', { tag: ['@homepage'] }, async ({ home, page }) => {
  await home.open();
  await page.waitForTimeout(3000);
  await expect(home.heroSlides().nth(1), 'the carousel autoplays past the first slide').toBeVisible();
});
