---
id: ACC-WCAG-AAA
name: Images Must Have an alt Attribute
severity: MAJOR
language:
  - html
  - isml
paths:
  - "cartridges/app_*/cartridge/templates/**/*.isml"
  - "cartridges/int_custom_*/cartridge/templates/**/*.isml"
category: Accessibility
tags: [accessibility, wcag, alt-text]
---

Every `<img>` needs an `alt` attribute — descriptive text for a content image, or `alt=""` for a purely decorative one. Without it, a screen reader announces the file name, or nothing.

Flag only an `<img>` tag that has no `alt`. This is markup-only: never flag `.js`/`.ts`/`.scss`, and never flag an `<svg>`, `<button>`, `<a>`, or any element that already has `alt`, `aria-label`, `aria-labelledby`, `title`, or visible text. An `<svg>` is not an `<img>` and never uses `alt`.

## Bad

```html
<img src="${URLUtils.staticURL('promo-banner.jpg')}" />
```

## Good

```html
<img src="${URLUtils.staticURL('promo-banner.jpg')}" alt="Summer sale, up to 50% off" />
<img src="${URLUtils.staticURL('divider.svg')}" alt="" />
<!-- decorative -->
```
