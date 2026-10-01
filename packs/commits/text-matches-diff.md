---
id: text-matches-diff
severity: MAJOR
tags: [judged]
---

# The text matches the diff

A changelog entry, release note or doc line the change adds describes what the diff does, no more and no less; a claim no line of the diff backs is removed or made true. Readers trust these texts instead of reading the code, so a wrong one misleads everyone after the change.

Good:

```md
- The export keeps the header row when the sheet is empty.
```

Bad:

```md
- The export keeps the header row when the sheet is empty, and now runs twice as fast.
```
