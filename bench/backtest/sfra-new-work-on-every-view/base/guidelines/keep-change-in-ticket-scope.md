---
id: keep-change-in-ticket-scope
severity: MAJOR
languages: [javascript]
paths:
  - "cartridges/**/*.js"
tags: [judged]
---

# New work stays on the path that needs it

A change must not add cost to code paths that do not use its result. Flag new lookups or model builds that run for every view when only one view reads them; do not claim a cost the diff or its data cannot show.

## Bad

```javascript
order.shipping = buildShippingModels(container); // list rows never read it
```

## Good

```javascript
if (options.containerView === 'order') {
    order.shipping = buildShippingModels(container);
}
```
