---
id: excluded-action-in-every-template
severity: MAJOR
languages: [isml]
paths:
  - "cartridges/**/templates/**/*.isml"
tags: [judged]
---

# An action excluded for a product is excluded everywhere it is offered

When a change removes an action (such as move to wishlist) for a product type in one template, every template that offers the same action for that product removes it too, including templates the diff does not touch.

## Bad

```html
<isif condition="${!lineItem.isGiftPack}"><button class="add-to-wishlist" /></isif>
<!-- removeDialog.isml still offers move to wishlist -->
```

## Good

```html
<!-- both the card and the remove dialog check lineItem.isGiftPack -->
```
