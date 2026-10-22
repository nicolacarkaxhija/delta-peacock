---
id: churn-hides-the-change
severity: MINOR
languages: [javascript]
paths:
  - "cartridges/**/*.js"
tags: [judged]
---

# Rewrites stay out of a behaviour change

A change keeps unrelated rewrites (var to const, reformatting) out of the diff so the real change is reviewable. Flag a diff where most changed lines only rewrite declarations or formatting around a small behaviour change.

## Bad

```javascript
-var a = 1;
+const a = 1; // and dozens more, around one added argument
```

## Good

```javascript
-    return build(items);
+    return build(items, container);
```
