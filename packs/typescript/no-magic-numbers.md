---
id: no-magic-numbers
severity: MAJOR
languages: [typescript, javascript]
---

# Named numbers with a reason

Every timeout, delay, retry count, limit or threshold is a named constant declared once, next to the reason it has that value, so one place answers why the code waits or stops where it does. Zero, one and literals in a test that only describe the case need no name.

Good:

```ts
// The import service answers within 2 s at p99, so twice that before giving up.
const IMPORT_TIMEOUT_MS = 4_000;
await fetch(importUrl, { signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS) });
```

Bad:

```ts
await fetch(importUrl, { signal: AbortSignal.timeout(4000) });
if (attempt < 5) await retry();
```
