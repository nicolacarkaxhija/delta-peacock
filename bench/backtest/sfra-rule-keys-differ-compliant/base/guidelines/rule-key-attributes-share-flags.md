---
id: rule-key-attributes-share-flags
severity: MINOR
paths:
  - "meta/**/*.xml"
tags: [judged]
---

# Attributes keyed by one rule share their settings

Attributes that serve as keys of one categorization or sorting rule have the same localizable setting. Flag a change where two such attributes differ.

## Bad

```xml
<attribute-definition attribute-id="packModel"><localizable-flag>true</localizable-flag></attribute-definition>
<attribute-definition attribute-id="packType"><localizable-flag>false</localizable-flag></attribute-definition>
```

## Good

```xml
<!-- both keys localizable-flag false -->
```
