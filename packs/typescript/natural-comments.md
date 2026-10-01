---
id: natural-comments
severity: MINOR
languages: [typescript, javascript]
---

# Natural one line comments

A comment says what the code cannot: a reason, a quirk of a dependency, a limit of the platform, never a repeat of what the code already says. It says nothing about how the change was made, the work session or who wrote it, and it separates clauses with commas or colons instead of dashes. Any punctuation may appear, semicolons as well, except dashes and doubled hyphens, and a comment never runs past a single line.

Good:

```ts
// The calendar API counts months from zero, so January is 0.
```

Bad:

```ts
// Rewrote this after the review -- the old version broke on leap years,
// and the second attempt finally works.
```
