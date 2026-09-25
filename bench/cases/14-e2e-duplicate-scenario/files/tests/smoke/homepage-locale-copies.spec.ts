import { expect, test } from '../../support/fixtures.js';

test(
  'The homepage hero carousel renders for the German locale',
  { tag: ['@homepage', '@not-site:US'] },
  async ({ home }) => {
    await home.open();
    await expect(home.heroCarousel(), 'a healthy homepage renders its hero carousel').toBeVisible();
  },
);

test(
  'The homepage hero carousel renders for the Japanese locale',
  { tag: ['@homepage', '@not-site:US'] },
  async ({ home }) => {
    await home.open();
    await expect(home.heroCarousel(), 'a healthy homepage renders its hero carousel').toBeVisible();
  },
);
