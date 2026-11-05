---
id: logger-assigned-once
severity: MINOR
languages: [javascript]
paths: ["cartridges/**"]
check:
  type: semgrep
  files: ["cartridges/**/*.js"]
  message: "A log call never chains on getLogger: the logger is assigned once and every call goes through it."
---

# Assign the logger once

A log call never chains on getLogger: the logger is assigned once and every call goes through it. Assign `const logger = require('dw/system/Logger').getLogger('<category>', '<file>');` at the top of the module, or reuse the module's existing logger, and call `logger.error(...)`.

Good:

```js
const logger = require('dw/system/Logger').getLogger('giftPack', 'checkout');

function pack(id) {
    logger.error('no pack {0}', id);
}
```

Bad:

```js
function pack(id) {
    require('dw/system/Logger').getLogger('giftPack', 'checkout').error('no pack {0}', id);
}
```
