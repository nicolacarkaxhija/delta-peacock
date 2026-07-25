---
id: no-any-escape-hatch
severity: MAJOR
languages: [typescript]
---

# Do not escape the type system with any

Reaching for `any` or an unchecked `as` cast to silence the compiler hides the
real defect. Model the type, narrow with a guard, or use `unknown` and validate.
A cast is a claim the reviewer should be able to trust.
