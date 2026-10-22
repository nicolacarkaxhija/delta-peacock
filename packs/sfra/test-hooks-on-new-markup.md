---
id: test-hooks-on-new-markup
severity: MINOR
languages: [isml]
paths:
  - "cartridges/**/templates/**/*.isml"
tags: [judged]
---

# New markup carries test hooks and one template

New shopper visible lines carry a test hook attribute (data-testid), and the desktop and client rendered markup of one card do not fork into duplicated templates. Flag new visible elements without a test hook.

## Bad

```html
<div class="pack__size">${line.size}</div>
```

## Good

```html
<div class="pack__size" data-testid="pack-size">${line.size}</div>
```
