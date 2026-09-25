---
id: spec-naming-per-kind
severity: MINOR
languages: [typescript]
paths: ['tests/**']
---

# Spec files sit in their intent folder and name what they cover

tests/<intent>/<page or feature>.spec.ts in kebab case: smoke, journeys, tools, or one folder per quality kind. The folder decides the profile and the report grouping.

Good:

```ts
tests / smoke / pdp - size - guide.spec.ts;
```

Bad:

```ts
tests/SizeGuideTest.ts
tests/new/test1.spec.ts
```
