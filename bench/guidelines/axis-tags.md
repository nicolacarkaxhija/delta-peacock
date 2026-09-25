---
id: axis-tags
severity: MINOR
languages: [typescript]
paths: ['tests/**']
---

# Axis tags restrict or exclude only where a test must; a feature tag names what it covers

A test with no tag on an axis runs on every value of that axis the active profile selects: no site tag means every site, no device tag means desktop and mobile. That is the default, not a gap. `@site:EU` restricts a test to EU; `@not-site:US` keeps it on every site but US, and is complete on its own. Neither form is required. Tag an axis only when the test cannot pass on some of its values, and prefer the `@not-` form when only one or two values are the exception. Put the tags in the tag option rather than the title.

Beside them a test should carry one feature tag from `tags.features` in `test-runner.config.ts`, so `--grep @cart` reaches every cart test. This is a recommendation: `test-runner check` accepts a test without one. It refuses a tag that is neither an axis tag nor declared, so never suggest `@smoke` or any other word the config does not list; the folder already says the intent.

When no declared feature in `tags.features` covers a test, the test carries no feature tag, and that is not a finding.

Good:

```ts
test('the cart shows the added line', { tag: ['@cart'] }, async ({ cart }) => {
```

```ts
test('the hero carousel renders a slide', { tag: ['@not-site:US'] }, async ({ home }) => {
```

```ts
test('the cart shows the added line', { tag: ['@site:EU', '@not-env:prd', '@cart'] }, async ({ cart }) => {
```

Bad:

```ts
test('the cart shows the added line @cart @site:EU', async ({ cart }) => {
```

```ts
test('the homepage renders', { tag: ['@not-site:US', '@smoke'] }, async ({ home }) => {
```
