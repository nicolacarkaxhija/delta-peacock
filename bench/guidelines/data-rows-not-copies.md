---
id: data-rows-not-copies
severity: MAJOR
languages: [typescript]
paths: ['tests/**']
---

# One scenario with data rows, never copies per site or product

Copies drift: a fix lands in one and not the others. A site, product, payment method or address is a row of the same scenario.

Good:

```ts
for (const method of ['card', 'paypal'] as const) {
  test(`pays with ${method}`, { tag: ['@site:EU', '@not-env:prd'] }, async ({ checkout }) => {
    await checkout.pay(method);
  });
}
```

Bad:

```ts
// checkout-card.spec.ts and checkout-paypal.spec.ts, identical but for one line
```
