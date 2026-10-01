---
id: explained-css-selectors
severity: MINOR
languages: [typescript, javascript]
paths: ["tests/**", "pages/**"]
---

# Locate what a user perceives

A locator names what a user perceives: a role, a label, a text or a test id. Where a CSS selector is unavoidable, a comment next to it gives the reason. A class name changes with every restyle, so a selector built on one breaks without any change in behavior.

Good:

```ts
saveButton(): Locator {
  return this.page.getByRole("button", { name: "Save" });
}
```

Bad:

```ts
saveButton(): Locator {
  return this.page.locator(".toolbar > .btn-primary");
}
```
