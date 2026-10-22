---
id: flag-has-a-setter
severity: MAJOR
paths:
  - "cartridges/**/*.js"
  - "meta/**/*.xml"
tags: [judged]
---

# A shopper facing flag has a named setter

A new attribute that changes what shoppers see must have a source that sets it in the same change or in its description: an import mapping, a rule or a merchant field. Flag a new flag that code reads while nothing in the change says who sets it.

## Bad

```xml
<attribute-definition attribute-id="isGiftPack">
    <type>boolean</type>
</attribute-definition>
```

## Good

```xml
<attribute-definition attribute-id="isGiftPack">
    <description xml:lang="x-default">Set by the catalog import from the pack column.</description>
    <type>boolean</type>
</attribute-definition>
```
