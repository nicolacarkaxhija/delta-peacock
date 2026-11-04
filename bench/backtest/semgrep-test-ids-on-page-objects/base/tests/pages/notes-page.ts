import type { Page } from "@playwright/test";

export class NotesPage {
  readonly add = this.page.getByTestId("notes-add");

  constructor(private readonly page: Page) {}
}
