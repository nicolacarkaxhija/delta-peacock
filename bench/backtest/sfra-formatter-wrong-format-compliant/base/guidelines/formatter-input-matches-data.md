---
id: formatter-input-matches-data
severity: MAJOR
languages: [javascript]
paths:
  - "cartridges/**/*.js"
tags: [judged]
---

# A formatter gets the format it documents

A formatter receives the data format its contract names. Flag a call that passes data whose documented format differs from the format the formatter documents, without a conversion step.

## Bad

```javascript
line.size = jpSizeFormatter(product.custom.sizeName); // sizeName is EU;UK, the formatter expects JP;EU
```

## Good

```javascript
line.size = jpSizeFormatter(toJpEu(product.custom.sizeName));
```
