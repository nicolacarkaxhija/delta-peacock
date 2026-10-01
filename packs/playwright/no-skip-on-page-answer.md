---
id: no-skip-on-page-answer
severity: MAJOR
languages: [typescript, javascript]
paths: ["tests/**", "pages/**"]
tags: [judged]
---

# Never skip on what the page answered

A test never skips itself on what the page answered: an empty list, a missing element or an error page is a result to assert, not a reason to skip. A skip that depends on the page turns every regression it should catch into a pass.

Good:

```ts
await search.query("lamp");
await expect(search.results()).toHaveText(["Desk lamp", "Floor lamp"]);
```

Bad:

```ts
await search.query("lamp");
test.skip((await search.results().count()) === 0, "no results today");
```
