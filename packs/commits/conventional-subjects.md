---
id: conventional-subjects
severity: MINOR
tags: [judged]
---

# Conventional subjects

Every commit subject, pull request title or changelog heading the change writes, or that a script or template in it produces, reads `type(scope): summary` on one line, in the imperative mood and without a closing period. A history in that shape sorts itself into features, fixes and chores, and release notes follow from it.

Good:

```sh
git commit -m "fix(export): keep the header row when the sheet is empty"
```

Bad:

```sh
git commit -m "Fixed export bug."
```
