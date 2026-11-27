---
id: docs-match-signature
severity: MINOR
languages: [javascript]
paths: ["packages/**/*.js"]
check:
  type: ast
  rule: jsdoc-matches-signature
  message: "Every new or changed function carries a doc comment whose parameters and return type match what the code accepts and returns."
exclusions:
  - "A function that returns nothing needs no @returns tag."
---

# A function's doc comment matches what the code does

Every new or changed function carries a doc comment whose parameters and return type match what the code accepts and returns.

A function that returns nothing needs no @returns tag.

Good:

```js
/**
 * @param {Object} album the album to count
 * @returns {number} the picture count, 0 for an empty album
 */
function count(album) {
```

Bad:

```js
/**
 * @param {Object} gallery the album to count
 */
function count(album) {
```
