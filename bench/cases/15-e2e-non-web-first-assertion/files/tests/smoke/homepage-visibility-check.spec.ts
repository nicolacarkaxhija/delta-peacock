import { expect, test } from '../../support/fixtures.js';

test('The homepage hero carousel is visible', { tag: ['@homepage'] }, async ({ home }) => {
  await home.open();
  expect(await home.heroCarousel().isVisible()).toBe(true);
});
