import { expect, test } from '../../support/fixtures.js';

test(
  'The homepage renders its hero carousel',
  { tag: ['@homepage', '@quickwin'] },
  async ({ home }) => {
    await home.open();
    await expect(home.heroCarousel(), 'a healthy homepage renders its hero carousel').toBeVisible();
  },
);
