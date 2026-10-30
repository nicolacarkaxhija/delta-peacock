---
id: axis-tags
severity: MINOR
languages: [typescript]
paths: ['tests/**']
---

# A test carries only axis tags and the feature tags the config declares

Axis tags place a test on a site, an environment or a device: `@site:X`, `@not-site:X`, `@env:X`, `@not-env:X`, `@device:X`, `@not-device:X`. Feature tags are the keys `test-runner.config.ts` lists under `tags.features`. A test carries only axis tags and the feature tags the config declares.

A test with no tag on an axis runs on every value of that axis the active profile selects: no site tag means every site, no device tag means desktop and mobile. Tag an axis only when the test cannot pass on some of its values.

Good:

```ts
test('the list shows the added note', { tag: ['@site:alpha', '@not-env:prd', '@notes'] }, async ({ notes }) => {
```

Bad:

```ts
test('the list shows the added note', { tag: ['@smoke', '@notes'] }, async ({ notes }) => {
```
