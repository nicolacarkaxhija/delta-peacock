---
id: no-inline-timeouts
severity: MAJOR
languages: [typescript]
paths: ['tests/**', 'pages/**', 'components/**', 'support/**']
---

# No inline timeouts or sleeps

Waits longer than the framework defaults live as named values in one timeouts module, which then explains every slow run in one place. That module is support/timeouts.ts. waitForTimeout has no valid use.

Good:

```ts
await expect(dialog).toBeVisible({ timeout: timeouts.dialogOpen });
```

Bad:

```ts
await page.waitForTimeout(3000);
await expect(dialog).toBeVisible({ timeout: 6000 });
```
