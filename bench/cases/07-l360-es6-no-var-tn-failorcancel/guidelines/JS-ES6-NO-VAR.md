---
id: JS-ES6-NO-VAR
name: Never Declare a Variable with var
severity: MINOR
language:
  - javascript
paths:
  - "cartridges/app_*/cartridge/controllers/**/*.js"
  - "cartridges/app_*/cartridge/scripts/**/*.js"
  - "cartridges/app_*/cartridge/models/**/*.js"
  - "cartridges/app_*/cartridge/experience/**/*.js"
category: Maintainability
tags: [es6, clean-code]
---

Declare variables with `let` or `const` -- either is fine -- never `var`. This applies to first-party server-side `.js` we own -- under `cartridges/app_*/cartridge/{controllers,scripts,models,experience}`.

Flag only an added line that begins a declaration with the `var` keyword -- nothing else. This rule does not compare `let` against `const`: do not flag a `let` you think should have been `const`, a `const` you think should have been `let`, or a diff that changes one to the other. Any added line already using `let` or `const` is correct as written, regardless of which of the two it is or why it changed. `var` inside a word like `variation` is not the keyword. Skip vendor cartridges (`int_*`, `plugin_*`, `link_*`), TypeScript, client-side code, and generated files.

## Bad

```javascript
var total = 0; // use let or const instead
```

## Good

```javascript
let total = 0; // let is fine, even if it could arguably be const
const variationModel = product.variationModel; // "var" here is only a substring
```
