---
id: no-order-dependent-arithmetic
severity: MINOR
languages: [javascript]
paths:
  - "cartridges/**/*.js"
tags: [judged]
---

# Totals are initialised before they grow

A total is not accumulated before it is initialised, and two layers do not both add to it. Flag an addition to a field that is assigned later in the same constructor or that the lower layer already sums.

## Bad

```javascript
this.totalQuantity += giftCertificates.length;
this.totalQuantity = countItems(items);
```

## Good

```javascript
this.totalQuantity = countItems(items) + giftCertificates.length;
```
