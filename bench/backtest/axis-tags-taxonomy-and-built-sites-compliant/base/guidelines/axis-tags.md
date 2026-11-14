---
id: axis-tags
severity: MINOR
languages: [typescript]
paths: ['tests/**']
---

# A test carries only the tags the config declares

Axis tags place a test on a site, an environment or a device: `@site:X`, `@not-site:X`, `@env:X`, `@not-env:X`, `@device:X`, `@not-device:X`. Feature tags are the keys `test-runner.config.ts` lists under `tags.features`. Taxonomy tags are `@<dimension>:<value>` for the values `taxonomy.dimensions` lists, `@risk:P0` to `@risk:P3`, `@feature:<feature>`, and `unclassified` on a required dimension; they count as axis tags here.

A test carries only axis tags and the feature tags the config declares, never `@smoke` or another tag the config does not list.

Tags belong in the tag option, never in the test title.

Good:

```ts
test('the list shows the added note', { tag: ['@site:alpha', '@risk:P1', '@effect:sends-mail', '@notes'] }, async ({ notes }) => {
```

Bad:

```ts
test('the list shows the added note', { tag: ['@smoke', '@notes'] }, async ({ notes }) => {
```
