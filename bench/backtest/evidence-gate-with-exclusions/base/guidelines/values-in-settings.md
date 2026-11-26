---
id: values-in-settings
severity: MAJOR
languages: [javascript]
paths: ['src/**']
exclusions:
  - A default used only when the setting is missing is not a business value.
---

# Business values live in settings

A business value such as a limit or an amount is read from a setting, never compared inline.

A default used only when the setting is missing is not a business value.

Good:

```js
return basket.total >= settings.get('freeShippingFrom');
```

Bad:

```js
return basket.total >= 50;
```
