---
id: page-object-actions
severity: MAJOR
languages: [typescript]
paths: ['pages/**', 'components/**']
---

# Page and component object members return locators, values or nothing; no assertions

The spec owns the verdict. A page or component object that asserts hides the expectation from the reader and cannot be reused where the opposite outcome is expected.

Good:

```ts
async addToCart(): Promise<void> {
  await this.testId('addToCart').click();
}
```

Bad:

```ts
async addToCart(): Promise<void> {
  await this.testId('addToCart').click();
  await expect(this.testId('minicartCount')).toHaveText('1');
}
```
