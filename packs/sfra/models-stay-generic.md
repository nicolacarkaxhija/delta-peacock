---
id: models-stay-generic
severity: MAJOR
languages: [javascript]
paths:
  - "cartridges/**/models/**/*.js"
tags: [judged]
---

# Shared view models hold no campaign rules

A shared view model (menu, search, category) contains no rule named after one campaign or one record id; the rule is generic and the campaign supplies data. Flag a comparison against a literal category, campaign or product id in such a model.

## Bad

```javascript
if (category.ID === "gift-pack") {
  hidden = !hasStock(category);
}
```

## Good

```javascript
if (categoryHelpers.isSoldOutTileLanding(category)) {
  return;
}
```
