---
id: one-source-one-group
severity: MINOR
paths:
  - "meta/**/*.xml"
tags: [judged]
---

# One feature, one source of truth, one attribute group

One feature has one attribute group and one source of truth. Flag a change that adds a second flag or group for a fact the same change already models, unless a comment names the reason. A single new definition is fine even when a later change reuses it.

## Bad

```xml
<attribute-definition attribute-id="isGiftPack"/> <!-- group Bundles -->
<attribute-definition attribute-id="giftPackType"/> <!-- group GiftPack -->
```

## Good

```xml
<attribute-group group-id="GiftPack">
    <attribute attribute-id="isGiftPack"/>
</attribute-group>
```
