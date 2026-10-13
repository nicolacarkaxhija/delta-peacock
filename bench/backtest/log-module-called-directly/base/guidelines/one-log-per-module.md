---
id: one-log-per-module
severity: MAJOR
languages: [javascript]
paths: ["server/**/*.js"]
check:
  type: pattern
  added: '(?:getLog\s*\(\s*(?:\)|[\x27"][^\x27"]*[\x27"]\s*,)|require\s*\(\s*[\x27"]app/system/Log[\x27"]\s*\)\s*\.(?:error|warn|info|debug)\s*\()'
  unless: '^\s*(?://|\*|/\*)'
  message: "A log is created once per module with getLog and one argument, a non empty category name, never the root log and never a second argument that opens a file."
exclusions:
  - "a plain category such as Payments is acceptable and never a finding"
---

# One log per module, one named category, no log files

A log is created once per module with getLog and one argument, a non empty category name, never the root log and never a second argument that opens a file.

Writing to the root log, through getLog() without a name or a level call on the Log module itself, cannot be filtered at all; a plain category such as Payments is acceptable and never a finding.

Good:

```js
var log = require('app/system/Log').getLog('content');
log.warn('Content {0} is missing', id);
```

Bad:

```js
require('app/system/Log').error('Content ' + id + ' is missing');
var log = require('app/system/Log').getLog('catalog', 'groupMapping');
```
