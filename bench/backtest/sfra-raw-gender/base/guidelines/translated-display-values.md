---
id: translated-display-values
severity: MINOR
languages: [javascript]
paths:
  - "cartridges/**/*.js"
tags: [judged]
---

# Shopper facing values are translated

A value shown to shoppers is mapped from the raw attribute to a translated display value with a resource key. Flag a raw attribute value assigned to a view model field that a template prints.

## Bad

```javascript
line.gender = product.custom.gender; // raw value, one language
```

## Good

```javascript
line.gender = Resource.msg('gender.' + product.custom.gender, 'product', null);
```
