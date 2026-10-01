---
id: natural-comments
severity: MINOR
languages: [typescript, javascript]
paths: ["src/**", "scripts/**", "tests/**", "*.config.ts", "*.config.js"]
---

# One plain single-line comment

A comment adds what the code does not show: a quirk of a dependency, a ticket, a reason. It says nothing about how the change was made, the work session or who wrote it, and it separates clauses with commas or colons instead of dashes.
Any punctuation may appear, semicolons as well, except dashes and doubled hyphens, and a comment never runs past a single line unless it is a doc comment.

Good:

```ts
// The payment provider rounds to cents on its side, so totals are compared in cents.
```

Bad:

```ts
// Spent the whole afternoon on this one, it is stable at last!
// Tried three approaches first, see the chat.
```
