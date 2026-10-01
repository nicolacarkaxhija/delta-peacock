---
id: one-behavior-per-change
severity: MINOR
tags: [judged]
---

# One behavior per change

A change does one thing a user of the code would name: a feature, a fix and a refactor land as separate changes, and a formatting sweep never rides along with a fix. A reviewer then reads one intent, and a revert takes back exactly one.

Good:

```diff
 export function total(items: Item[]): number {
-  return items.reduce((sum, item) => sum + item.price, 0);
+  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
 }
```

Bad:

```diff
 export function total(items: Item[]): number {
-  return items.reduce((sum, item) => sum + item.price, 0);
+  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
 }
+
+export function exportCsv(items: Item[]): string {
+  return items.map((item) => `${item.name},${String(item.price)}`).join("\n");
+}
```
