---
id: no-floating-promises
severity: MAJOR
languages: [typescript, javascript]
---

# No floating promises

Every promise must be awaited, returned, or explicitly handled. A floating
promise swallows errors and reorders effects in ways that surface as flaky,
unreproducible bugs.
