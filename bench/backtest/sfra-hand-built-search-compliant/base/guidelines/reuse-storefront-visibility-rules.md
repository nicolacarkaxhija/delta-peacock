---
id: reuse-storefront-visibility-rules
severity: MAJOR
languages: [javascript]
paths:
  - "cartridges/**/*.js"
tags: [judged]
---

# Visibility checks reuse the listing search

A check that decides whether an item shows applies the same refinements as the listing it links to, through the shared function that builds that search. Flag a new search built by hand where a shared search builder exists.

## Bad

```javascript
var search = new ProductSearchModel();
search.setCategoryID(id);
search.search();
```

## Good

```javascript
var search = searchHelpers.createVisibleSearch(id);
```
