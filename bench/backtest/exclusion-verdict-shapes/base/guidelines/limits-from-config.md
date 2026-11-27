---
id: limits-from-config
severity: MAJOR
languages: [javascript]
paths: ['src/**']
exclusions:
  - A fallback applied only when the configured value is absent is not a tunable value.
---

# Read limits and amounts from configuration

A limit or an amount that operations may tune is read from configuration, never compared as a literal.

A fallback applied only when the configured value is absent is not a tunable value.

Good:

```js
return basket.total >= settings.get('freeShippingFrom');
```

Bad:

```js
return basket.total >= 50;
```
