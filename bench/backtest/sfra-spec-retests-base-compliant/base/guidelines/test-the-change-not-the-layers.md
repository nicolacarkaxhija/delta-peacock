---
id: test-the-change-not-the-layers
severity: MAJOR
languages: [javascript]
paths:
  - "test/unit/**/*.js"
  - "test/mocks/**/*.js"
tags: [judged]
---

# A spec tests what the change adds

A spec asserts the behavior the change adds, not behavior owned by the base cartridge or another layer. Flag a new case whose assertion only holds because of code the change did not touch.

## Bad

```javascript
it('adds gift certificates to the total', function () { /* base model behavior */ });
```

## Good

```javascript
it('passes the container to the line item model', function () { /* the added call */ });
```
