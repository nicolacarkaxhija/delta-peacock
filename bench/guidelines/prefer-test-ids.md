---
id: prefer-test-ids
severity: MINOR
languages: [typescript]
paths: ['pages/**', 'components/**']
---

# getByTestId first, then role and name, CSS last

A test id survives restyling; a role with an accessible name survives markup changes; a CSS class survives neither. A CSS selector carries a comment saying why nothing better exists.

Good:

```ts
sizeGuide(): Locator {
  return this.testId('product_fitGuideTrigger');
}
```

Bad:

```ts
sizeGuide(): Locator {
  return this.page.locator('div.pdp > span:nth-child(3) a');
}
```
