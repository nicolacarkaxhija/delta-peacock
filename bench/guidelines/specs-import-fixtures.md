---
id: specs-import-fixtures
severity: MAJOR
languages: [typescript]
paths: ['tests/**']
---

# Specs import test and expect from support/fixtures.ts

The suite fixtures carry the page objects, the target, the test data and the known issue behaviour; a spec importing from @playwright/test runs without all of it.

Good:

```ts
import { test, expect } from '../../support/fixtures.js';
```

Bad:

```ts
import { test, expect } from '@playwright/test';
```
