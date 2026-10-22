---
id: no-unused-mock-entry
severity: MINOR
languages: [javascript]
paths:
  - "test/unit/**/*.js"
  - "test/mocks/**/*.js"
tags: [judged]
---

# A shared mock entry is used or not added

An entry added to a shared mocks file must be used by a spec. Flag a new entry no spec reads.

## Bad

```javascript
module.exports = {
  stubPackAttributes: sinon.stub(), // no spec reads it
};
```

## Good

```javascript
const { stubPackAttributes } = require("../../mocks/packMocks");
```
