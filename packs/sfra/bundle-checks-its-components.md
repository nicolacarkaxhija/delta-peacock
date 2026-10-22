---
id: bundle-checks-its-components
severity: MAJOR
languages: [javascript]
paths:
  - "cartridges/**/*.js"
tags: [judged]
---

# A bundle is purchasable only when its components are

A rule that decides whether a bundle can be bought also requires each bundled product to be online and orderable for its bundled quantity. Flag a bundle check that reads only the bundle itself.

## Bad

```javascript
return bundle.online && bundle.availabilityModel.orderable;
```

## Good

```javascript
return (
  bundle.online &&
  isOrderable(bundle, 1) &&
  bundle.bundledProducts.toArray().every(function (p) {
    return isOrderable(p, bundle.getBundledProductQuantity(p).value);
  })
);
```
