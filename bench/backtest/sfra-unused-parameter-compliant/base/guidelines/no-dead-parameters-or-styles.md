---
id: no-dead-parameters-or-styles
severity: MINOR
languages: [javascript]
paths:
  - "cartridges/**/*.js"
tags: [judged]
---

# No parameter that no caller passes

A new parameter no caller passes, or a new style nothing renders, is removed. Flag a parameter added in the change that no call site in the repository supplies.

## Bad

```javascript
function hasPurchasable(cards, maxChecked) { /* every caller passes one argument */ }
```

## Good

```javascript
function hasPurchasable(cards) { /* ... */ }
```
