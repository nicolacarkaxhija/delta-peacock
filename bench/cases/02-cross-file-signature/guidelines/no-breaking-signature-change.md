---
id: no-breaking-signature-change
severity: CRITICAL
---

# No breaking signature changes

Changing a function's parameters breaks its callers. Update every caller in
the same change, or keep the old signature working.
