---
id: gate-new-work-on-the-flag
severity: MINOR
languages: [javascript]
paths:
  - "cartridges/**/*.js"
tags: [judged]
---

# Work for a flagged feature runs only under the flag

When a change adds work for products that carry a feature flag, that work runs only when the flag is set, so other products skip it. Flag new per product work next to a flag check that does not guard it.

## Bad

```javascript
line.size = sizeFormatter.format(product.custom.sizeName); // every bundle
line.isGiftPack = !!product.custom.isGiftPack;
```

## Good

```javascript
if (product.custom.isGiftPack) {
  line.size = sizeFormatter.format(product.custom.sizeName);
}
```
