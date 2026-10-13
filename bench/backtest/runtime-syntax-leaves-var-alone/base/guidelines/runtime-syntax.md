---
id: runtime-syntax
severity: BLOCKER
languages: [javascript]
paths: ["server/**/*.js"]
check:
  type: pattern
  added: '(?:\basync\s+function\b|\basync\s*\(|\bawait\s+\w|[\w\])]\?\.[\w\[(]|[\w\])\x27"]\s*\?\?\s*[\w\x27"(\[]|\{\s*\.\.\.\w)'
  unless: '^\s*(?://|\*|/\*)'
  message: "Server side code runs on an older engine, so async and await, optional chaining, nullish coalescing and object spread inside braces crash at runtime and never ship."
exclusions:
  - "var, let, const, arrow functions, template literals and destructuring all work and are never a finding here"
---

# Server code uses only the syntax its engine runs

Server side code runs on an older engine, so async and await, optional chaining, nullish coalescing and object spread inside braces crash at runtime and never ship.

var, let, const, arrow functions, template literals and destructuring all work and are never a finding here.

Good:

```js
var name = customer && customer.profile ? customer.profile.name : '';
```

Bad:

```js
var name = customer?.profile?.name;
```
