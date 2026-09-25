import { expect, test } from '../../support/fixtures.js';

test.skip(
  'The homepage hero carousel eventually renders a second slide',
  { tag: ['@homepage'] },
  async ({ home }) => {
    await home.open();
    await expect(home.heroSlides(), 'the carousel renders a second slide').toHaveCount(2);
  },
);
