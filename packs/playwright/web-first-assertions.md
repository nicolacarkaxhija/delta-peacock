---
id: web-first-assertions
severity: MAJOR
languages: [typescript, javascript]
paths: ["tests/**", "pages/**"]
---

# Assert with web first matchers

An assertion hands expect the locator itself and lets a web first matcher wait, never the awaited value of a getter. A web first matcher such as `toBeVisible`, `toHaveText`, `toHaveURL` or `toHaveCount` retries until the page settles; an awaited getter takes one snapshot of a page that is still changing, so the test fails on timing instead of on behavior.

Good:

```ts
await expect(notes.status()).toHaveText("Saved");
```

Bad:

```ts
expect(await notes.status().textContent()).toBe("Saved");
```
