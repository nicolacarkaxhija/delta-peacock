---
id: no-inline-timeouts
severity: MAJOR
languages: [typescript, javascript]
paths: ["tests/**", "pages/**"]
---

# No inline waits or timeouts

A test waits for the state it needs, never for a fixed time. waitForTimeout has no valid use. Waits longer than the framework defaults live as named values in one timeouts module, which then explains every slow run in one place.

Good:

```ts
await expect(report.status(), { timeout: TIMEOUTS.reportExport }).toHaveText("Ready");
```

Bad:

```ts
await page.waitForTimeout(3000);
await expect(report.status(), { timeout: 45000 }).toHaveText("Ready");
```
