---
id: known-failures-carry-a-ticket
severity: MAJOR
languages: [typescript, javascript]
paths: ["tests/**"]
tags: [judged]
---

# A known failure carries a ticket, an owner and an expiry

A test marked with `test.fail`, `test.fixme` or `test.skip` for a known defect names the ticket, the owner and the date the mark expires, next to the mark. Without them the mark outlives the defect and hides the next one.

Good:

```ts
// NOTES-412, owner: the notes team, expires 2026-12-31: the export drops emoji.
test.fail(true, "NOTES-412");
```

Bad:

```ts
test.fixme();
```
