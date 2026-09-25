---
id: web-first-assertions
severity: MAJOR
languages: [typescript]
paths: ['tests/**', 'support/**']
---

# Web-first assertions, never polled getters

An assertion on a locator retries until the page settles; a value read once with isVisible(), count() or textContent() is a snapshot that flakes on a slow render. The rule is about that read: an awaited getter inside expect. A second argument to expect is a custom message and is valid Playwright, so `expect(locator, 'message')` is never a finding.

Good:

```ts
await expect(cart.lineItems(), 'the cart keeps the one line added').toHaveCount(1);
```

Bad:

```ts
expect(await cart.lineItems().isVisible()).toBe(true);
```
