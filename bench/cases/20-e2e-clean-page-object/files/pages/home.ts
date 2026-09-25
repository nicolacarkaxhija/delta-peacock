import type { Locator } from '@playwright/test';
import { BasePage } from './base.js';

export class HomePage extends BasePage {
  open(): Promise<void> {
    return super.open('home');
  }

  heroCarousel(): Locator {
    return this.page.getByTestId('carousel_hero').first();
  }

  heroSlides(): Locator {
    return this.page.getByTestId('carousel_hero_item');
  }

  promoBanner(): Locator {
    return this.page.getByTestId('promo_banner').first();
  }
}
