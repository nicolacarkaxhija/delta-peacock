import { defineConfig } from './support/define-config.js';

// Trimmed for the bench: the parts a review reads.
export default defineConfig({
  sites: {
    EU: { locales: { 'de-DE': {}, 'en-GB': {}, 'fr-FR': {} } },
    US: { locales: { 'en-US': {} } },
    JP: { locales: { 'ja-JP': {} } },
  },
  environments: { dev: {}, stg: {}, prd: {} },
  devices: { desktop: {}, mobile: {} },
  tags: {
    features: {
      checkout: 'the checkout funnel, from the guest choice screen to the priced review step',
      payments: 'which payment methods a site offers, and selecting one',
      cart: 'the cart page, its lines, quantities and totals',
      pdp: 'the product detail page, its variations and its buy box',
      plp: 'category listing, refinement and sort',
      search: 'the search results page and its relevance',
      homepage: 'the homepage and its hero carousel',
      promotions: 'coupon codes and order level discounts',
    },
  },
});
