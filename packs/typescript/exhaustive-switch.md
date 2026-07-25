---
id: exhaustive-switch
severity: MAJOR
languages: [typescript]
---

# Switches over unions must be exhaustive

A switch over a discriminated union should handle every member and fail loudly
on the rest, for example with a `never`-typed default. Silent fall-through means
a new union member ships unhandled.
