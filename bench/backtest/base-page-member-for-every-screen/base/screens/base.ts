import type { Locator, Page } from '@playwright/test';

/** What every screen of the app has. */
export class BaseScreen {
  constructor(protected readonly page: Page) {}

  heading(): Locator {
    return this.page.getByRole('heading', { level: 1 });
  }
}
