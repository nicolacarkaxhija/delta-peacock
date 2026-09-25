import { expect, test } from '../../support/fixtures.js';

test('The homepage hero carousel renders more than one slide', { tag: ['@homepage'] }, async ({ home }) => {
  await home.open();
  await expect(
    home.heroSlides(),
    'the carousel gives the shopper more than one slide to browse',
  ).not.toHaveCount(1);
});
