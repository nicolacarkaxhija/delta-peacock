---
id: locale-files-hold-approved-copy
severity: MINOR
paths:
  - "cartridges/**/*.properties"
tags: [judged]
---

# Locale files hold approved copy

A locale properties file added in a change holds translated copy or does not exist; the default locale falls back. Flag a new locale file whose values repeat the default English text or read as a draft.

## Bad

```properties
# pack_ja.properties
pack.title=Gift pack
```

## Good

```properties
# only pack.properties is added; the translation follows
```
