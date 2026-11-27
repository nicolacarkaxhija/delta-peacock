---
id: views-show-only
severity: MAJOR
languages: [javascript]
paths: ['src/views/**']
exclusions:
  - A formatting call on a model value is presentation and not a finding.
  - A flag the view stores from a text check on a model value, such as indexOf on a facet id, keeps a display value and is not a finding.
---

# A view shows what the model holds

A view function only arranges values the model already holds.

A require in a view is a finding.

A computation that produces new data in a view is a finding.

A formatting call on a model value is presentation and not a finding.

A flag the view stores from a text check on a model value, such as indexOf on a facet id, keeps a display value and is not a finding.
