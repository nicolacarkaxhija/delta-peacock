---
id: web-first-assertions
severity: MAJOR
languages: [typescript, javascript]
paths: ["tests/**", "pages/**"]
---

# Assert with web first matchers

An assertion hands the locator to a matcher that retries until the page settles, such as `toBeVisible`, `toHaveText`, `toHaveURL` or `toHaveCount`. What counts is the read itself: expect wrapped around an awaited getter. Such a read takes one snapshot of a page that is still changing, so the test fails on timing instead of on behavior.

Good:

```ts
await expect(notes.status()).toHaveText("Saved");
```

Bad:

```ts
expect(await notes.status().textContent()).toBe("Saved");
```
