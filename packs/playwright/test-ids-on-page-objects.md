---
id: test-ids-on-page-objects
severity: MAJOR
languages: [typescript, javascript]
paths: ["tests/**"]
check:
  type: semgrep
  message: "A test id literal appears once, as a readonly named locator on the page object that owns it."
---

# Test ids live on their page object

A test id literal appears once, as a readonly named locator on the page object that owns it. Specs and page object methods use that field, so a renamed test id changes one line.

Good:

```ts
export class NotesPage {
  readonly add = this.page.getByTestId("notes-add");
  constructor(private readonly page: Page) {}
}
```

Bad:

```ts
await page.getByTestId("notes-add").click();
```
