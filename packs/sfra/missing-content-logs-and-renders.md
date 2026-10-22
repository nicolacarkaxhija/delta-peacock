---
id: missing-content-logs-and-renders
severity: MAJOR
languages: [javascript]
paths:
  - "cartridges/**/*.js"
tags: [judged]
---

# A content gap logs and renders

A content gap, such as an empty display name, never throws in a getter or model a template reads; log at error level and render, so one record does not take the page down. Flag a throw on missing content in such code.

## Bad

```javascript
if (!category.displayName) {
  throw new TypeError("no display name");
}
```

## Good

```javascript
if (!category.displayName) {
  Logger.error("category {0} has no display name", category.ID);
}
```
