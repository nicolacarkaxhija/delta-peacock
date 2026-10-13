---
id: spec-names-say-what-they-cover
severity: MINOR
languages: [typescript]
paths: ['tests/**']
---

# Spec files sit in their intent folder and name what they cover

tests/<intent>/<screen or feature>.spec.ts in kebab case: smoke, journeys, or one folder per test type. The folder decides the profile and the report grouping.

Good:

```ts
// tests/smoke/note-sharing.spec.ts
```

Bad:

```ts
// tests/SharingTest.ts
// tests/new/test1.spec.ts
```
