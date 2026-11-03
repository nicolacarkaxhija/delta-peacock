---
id: no-debug-output
severity: MAJOR
languages: [javascript]
paths: ['src/**']
---

# No debug output in shipped code

Shipped code never calls console.log; it writes through the module logger.

Good:

```js
logger.info('widget ready');
```

Bad:

```js
console.log('widget ready');
```
