---
id: docs-match-signature
severity: MINOR
languages: [javascript]
paths: ["server/**/*.js"]
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
 * @param {Object} basket the basket to price
 * @returns {number} the total, 0 for an empty basket
 */
function total(basket) {
```

Bad:

```js
/**
 * @param {Object} currentBasket the basket to price
 */
function total(basket) {
```
