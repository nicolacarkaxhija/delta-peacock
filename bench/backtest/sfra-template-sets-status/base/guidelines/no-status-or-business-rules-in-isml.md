---
id: no-status-or-business-rules-in-isml
severity: MAJOR
languages: [isml]
paths:
  - "cartridges/**/templates/**/*.isml"
tags: [judged]
---

# Status and page decisions live in code, not templates

The response status and the decision that a page is a landing live in middleware or a model; a template does not set or override a status. Flag isstatus or a business decision added to a template.

## Bad

```html
<isstatus value="200"/>
```

## Good

```html
<!-- the middleware asks isTileLanding(productSearch) and sets the status -->
```
