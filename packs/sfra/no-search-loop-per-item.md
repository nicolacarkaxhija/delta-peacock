---
id: no-search-loop-per-item
severity: MINOR
languages: [javascript]
paths:
  - "cartridges/**/*.js"
tags: [judged]
---

# No search per rendered card

A render does not run one search or product lookup per card; prefer one query and read counts from its refinements. Flag a search or product lookup inside a loop over cards, tiles or categories.

## Bad

```javascript
return cards.filter(function (card) {
  return searchFor(card).count > 0;
});
```

## Good

```javascript
var values = search.refinements.getNextLevelCategoryRefinementValues(parent);
```
