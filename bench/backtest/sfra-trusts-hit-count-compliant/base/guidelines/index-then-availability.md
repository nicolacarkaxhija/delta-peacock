---
id: index-then-availability
severity: MAJOR
languages: [javascript]
paths:
  - "cartridges/**/*.js"
tags: [judged]
---

# The search index pre-filters, the product decides

Use the search index to pre-filter candidates, then confirm each with the product availability model. Read hit.product; read a represented product only for a master or variation group hit. Flag a result that trusts the hit count alone or reads the first represented product of a bundle hit.

## Bad

```javascript
return search.count > 0;
```

## Good

```javascript
return search.productSearchHits.asList().toArray().some(function (hit) {
    return hit.product.availabilityModel.isOrderable();
});
```
