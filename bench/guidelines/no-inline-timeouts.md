---
id: no-inline-timeouts
severity: MAJOR
languages: [typescript]
paths: ['tests/**', 'pages/**', 'components/**', 'support/**']
---

# No inline timeouts or sleeps

Every wait beyond Playwright's own timeouts is a named entry in support/timeouts.ts, so one file answers why a run is slow. waitForTimeout is never correct.

Good:

```ts
await expect(dialog).toBeVisible({ timeout: timeouts.dialogOpen });
```

Bad:

```ts
await page.waitForTimeout(3000);
await expect(dialog).toBeVisible({ timeout: 6000 });
```
