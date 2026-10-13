---
id: known-failures-carry-a-ticket
severity: MAJOR
languages: [typescript, javascript]
paths: ["tests/**"]
tags: [judged]
exclusions:
  - "A skip the configuration decides, for a page or a feature the target does not have, marks no failure and needs no ticket."
---

# A known failure carries a ticket, an owner and an expiry

A test marked with `test.fail`, `test.fixme` or `test.skip` for a known defect names the ticket, the owner and the date the mark expires, next to the mark. Without them the mark outlives the defect and hides the next one.

A skip the configuration decides, for a page or a feature the target does not have, marks no failure and needs no ticket.

Good:

```ts
// NOTES-412, owner: the notes team, expires 2026-12-31: the export drops emoji.
test.fail(true, "NOTES-412");

// this target has no sharing, so there is nothing to test
test.skip(!config.hasFeature("sharing"), "sharing is not part of this target");
```

Bad:

```ts
test.fixme();
```
