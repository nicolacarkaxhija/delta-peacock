---
id: new-category-ships-closed
severity: MAJOR
paths:
  - "meta/**/*.xml"
tags: [judged]
---

# A new campaign category ships offline

A campaign category introduced by a change ships offline and out of the menu; the business switches it on at launch. Flag a new category with online-flag true or a menu flag set.

## Bad

```xml
<category category-id="pack-landing">
    <online-flag>true</online-flag>
</category>
```

## Good

```xml
<category category-id="pack-landing">
    <online-flag>false</online-flag>
</category>
```
