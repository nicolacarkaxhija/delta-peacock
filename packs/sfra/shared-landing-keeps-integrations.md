---
id: shared-landing-keeps-integrations
severity: MINOR
languages: [isml]
paths:
  - "cartridges/**/templates/**/*.isml"
tags: [judged]
---

# A landing variant keeps the landing integrations

A template that renders on the shared landing path keeps that path's structured data and content integrations, or says why it drops them. Flag a new landing template that omits an include every sibling landing template has.

## Bad

```html
<isdecorate template="common/layout/page"> <!-- no structured data include --></isdecorate>
```

## Good

```html
<isinclude template="search/structuredData" />
```
