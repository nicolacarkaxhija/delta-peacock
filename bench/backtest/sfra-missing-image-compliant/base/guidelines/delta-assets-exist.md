---
id: delta-assets-exist
severity: MINOR
paths:
  - "meta/**/*.xml"
tags: [judged]
---

# Referenced assets ship with the change

A data change that references images or files ships them in the same change or leaves the reference empty. Flag a reference to a file the change does not add.

## Bad

```xml
<image>pack/hero.png</image> <!-- no file added -->
```

## Good

```xml
<image/>
```
