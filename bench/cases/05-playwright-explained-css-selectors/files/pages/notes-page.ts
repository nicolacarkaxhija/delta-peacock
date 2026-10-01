import type { Locator, Page } from "@playwright/test";

export class NotesPage {
  constructor(private readonly page: Page) {}

  items(): Locator {
    return this.page.locator(".note-list > li");
  }
}
