---
id: no-unused-exports
severity: MINOR
languages: [typescript, javascript]
tags: [judged]
---

# No unused exports

Every export has a caller outside its own module in the same change or before it; an export nobody imports widens the public surface and keeps dead code alive.

Good:

```ts
export function formatPrice(cents: number): string {
  return (cents / 100).toFixed(2);
}
// cart.ts imports formatPrice
```

Bad:

```ts
export function formatPriceLegacy(cents: number): string {
  return String(cents / 100);
}
// nothing imports formatPriceLegacy
```
