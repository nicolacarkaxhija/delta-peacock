import type { Locator } from '@playwright/test';
import { BasePage } from './base.js';

/** The storefront dropped both size guide test ids, and these classes are the same in every language. */
const SIZE_GUIDE_TRIGGER = '.fit-guide-trigger';
const SIZE_GUIDE_PANEL = '.fit-guide-drawer';

export class PdpPage extends BasePage {
  open(): Promise<void> {
    return super.open('pdp');
  }

  sizeGuidePanel(): Locator {
    return this.page.locator(SIZE_GUIDE_PANEL);
  }

  async openSizeGuide(): Promise<void> {
    await this.page.locator(SIZE_GUIDE_TRIGGER).click();
  }
}
