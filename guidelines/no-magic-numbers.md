---
id: no-magic-numbers
severity: MAJOR
languages: [typescript, javascript, shell]
paths: ["src/**", "scripts/**"]
---

# No inline timeouts, sleeps or magic numbers

Every timeout, delay, retry count, limit or threshold is a named constant declared once, next to the reason it has that value, so one place answers why the code waits or stops where it does. A bare sleep that waits for some state is never correct: wait for the state itself. Zero, one and minus one as plain arithmetic, and literals inside tests that only describe the case, are fine.

Good:

```ts
// The upstream API answers within 5 s at p99, so twice that.
const UPSTREAM_TIMEOUT_MS = 10_000;
await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
```

Bad:

```ts
await new Promise((resolve) => setTimeout(resolve, 3000));
await fetch(url, { signal: AbortSignal.timeout(7500) });
if (items.length > 37) paginate();
```
