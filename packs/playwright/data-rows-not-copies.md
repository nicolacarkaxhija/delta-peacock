---
id: data-rows-not-copies
severity: MAJOR
languages: [typescript, javascript]
paths: ["tests/**"]
---

# Data rows instead of copied tests

Tests that differ only in their data are one scenario looped over rows. Sites, products, payment methods and addresses become data rows of one scenario. A copy drifts the first time a fix reaches only one of them.

Good:

```ts
const rows = [
  { plan: "monthly", price: "9.00" },
  { plan: "yearly", price: "90.00" },
];
for (const row of rows) {
  test(`the ${row.plan} plan shows its price`, async ({ pricing }) => {
    await expect(pricing.price(row.plan)).toHaveText(row.price);
  });
}
```

Bad:

```ts
test("the monthly plan shows its price", async ({ pricing }) => {
  await expect(pricing.price("monthly")).toHaveText("9.00");
});
test("the yearly plan shows its price", async ({ pricing }) => {
  await expect(pricing.price("yearly")).toHaveText("90.00");
});
```
