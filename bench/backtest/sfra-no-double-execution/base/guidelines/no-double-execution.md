---
id: no-double-execution
severity: MAJOR
languages: [javascript]
paths:
  - "cartridges/**/*.js"
tags: [judged]
---

# A layer does not repeat the work of the model it extends

A model that calls the model below it must not run again the work that model already does (decorators, lookups, totals). Flag a call that repeats a step the called model performs; adding a field the lower model lacks is fine.

## Bad

```javascript
var order = new WidgetsOrder(container, options);
decorators.apply(order, container); // WidgetsOrder already applied them
```

## Good

```javascript
var order = new WidgetsOrder(container, options);
order.giftWrap = readGiftWrap(container);
```
