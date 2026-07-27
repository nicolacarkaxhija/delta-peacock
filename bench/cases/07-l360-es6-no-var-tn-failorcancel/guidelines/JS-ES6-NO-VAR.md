---
id: JS-ES6-NO-VAR
name: Prefer let and const over var
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

Declare variables with `let` (when reassigned) or `const` (when not), not `var`. This applies to first-party server-side `.js` we own — under `cartridges/app_*/cartridge/{controllers,scripts,models,experience}`.

Flag only an added line that begins a declaration with the `var` keyword. A line already using `let` or `const` is correct, and `var` inside a word like `variation` is not the keyword. Skip vendor cartridges (`int_*`, `plugin_*`, `link_*`), TypeScript, client-side code, and generated files.

## Bad

```javascript
var total = 0; // use let (reassigned) or const (not)
```

## Good

```javascript
let total = 0;
const variationModel = product.variationModel; // "var" here is only a substring
```
