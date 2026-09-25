---
id: one-shape-per-dimension
severity: MAJOR
languages: [typescript]
paths: ['test-runner.config.ts', 'support/**']
---

# One shape per site, environment, locale and device keyed structure

Every structure keyed by site, environment, locale, page or device uses the same explicit shape as its siblings, so a reader never has to learn a second layout for the same axis.

Good:

```ts
products: {
  EU: { stg: { sandal: 'arizona' } },
  US: { stg: { sandal: 'arizona' } },
}
```

Bad:

```ts
products: {
  EU: { sandal: 'arizona' },
  'US-stg': 'arizona',
}
```
