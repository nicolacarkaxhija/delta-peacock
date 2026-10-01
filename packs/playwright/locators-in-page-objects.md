---
id: locators-in-page-objects
severity: MAJOR
languages: [typescript, javascript]
paths: ["tests/**"]
tags: [judged]
---

# Locators live in page objects

A spec never builds a locator itself: every locator lives in a page object, and the spec calls the page object's methods. When the page changes, one page object changes with it instead of every spec that touches that page.

Good:

```ts
await notes.open();
await notes.add("Buy milk");
await expect(notes.items()).toHaveCount(1);
```

Bad:

```ts
await page.getByRole("textbox", { name: "New note" }).fill("Buy milk");
await expect(page.getByRole("listitem")).toHaveCount(1);
```
