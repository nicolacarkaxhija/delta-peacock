---
id: locators-live-in-pages
severity: MAJOR
languages: [typescript]
paths: ['tests/**', 'support/**']
---

# Locators live in page and component objects only

A selector outside pages/ and components/ is a second place to fix when the storefront changes; test-runner check fails on it, and the review names it before the check does.

Good:

```ts
await pdp.addToCart();
await expect(pdp.sizeGuideDialog()).toBeVisible();
```

Bad:

```ts
await page.locator('.size-guide-trigger').click();
```
