---
id: SFRA-NO-CONST-IN-LOOP
name: Do Not Declare const Directly in a Loop Body (Rhino Bug)
severity: BLOCKER
language:
  - javascript
paths:
  - "cartridges/app_*/cartridge/controllers/**/*.js"
  - "cartridges/int_*/cartridge/controllers/**/*.js"
  - "cartridges/app_*/cartridge/scripts/**/*.js"
  - "cartridges/int_*/cartridge/scripts/**/*.js"
  - "cartridges/app_*/cartridge/models/**/*.js"
  - "cartridges/int_*/cartridge/models/**/*.js"
  - "cartridges/app_*/cartridge/experience/**/*.js"
  - "cartridges/int_*/cartridge/experience/**/*.js"
category: Compatibility
tags: [sfra, sfcc, rhino, const, loop, runtime-error]
---

On Rhino (SFCC 22.7), a `const` **declared directly inside a loop's braces** (`for`, `while`, `for...of`, …) crashes at runtime: Rhino re-enters the block each iteration and rejects the repeated binding (bug #326). Use `let` there instead.

Only flag a `const` when you can point to the `for`/`while` loop directly enclosing it. If there is no such loop, there is nothing to flag — a `const` at function scope, inside a `.map`/`.forEach` callback, or in an `if` block is fine, because none of those is a loop body. _Using_ a const inside a loop is fine too; only declaring one is the bug. `let` and `var` in a loop are always fine.

## Bad

```javascript
for (var i = 0; i < items.length; i++) {
  const item = items[i]; // const declared in the loop body — crashes
}
```

## Good

```javascript
for (var i = 0; i < items.length; i++) {
  let item = items[i]; // let is fine
  code += CHARSET.charAt(item); // using a const from outside is fine
}
items.forEach(function (item) {
  const id = item.ID; // const in a callback is fine
});
```
