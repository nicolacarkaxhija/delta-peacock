---
id: all-surfaces-branch-on-the-flag
severity: MAJOR
languages: [isml]
paths:
  - "cartridges/**/templates/**/*.isml"
tags: [judged]
---

# Every surface that shows the content branches on the flag

When a change hides content behind a flag on one surface, every template that shows the same content branches on the same flag. Flag a change that branches one template while another template in the repository still renders the content unconditionally.

## Bad

```html
<isif condition="${!lineItem.isGiftPack}"><isinclude template="cart/bundledItems" /></isif>
<!-- mail/orderItem.isml still includes bundledItems for every bundle -->
```

## Good

```html
<!-- cart card, order mail and return picker all check lineItem.isGiftPack -->
```
