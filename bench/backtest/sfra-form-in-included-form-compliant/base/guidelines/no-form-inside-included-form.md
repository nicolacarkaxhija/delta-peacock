---
id: no-form-inside-included-form
severity: MAJOR
languages: [isml]
paths:
  - "cartridges/**/templates/**/*.isml"
tags: [judged]
---

# No form inside a form through an include

A template included inside a form must not contain a form of its own; browsers drop the inner form and its submit posts the outer one. Flag an include inside a form when the included template holds a form element.

## Bad

```html
<form id="profile">
    <isinclude template="account/linkedProviders"/> <!-- holds <form action="Unlink"> -->
</form>
```

## Good

```html
<form id="profile">...</form>
<isinclude template="account/linkedProviders"/>
```
