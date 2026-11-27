---
id: dates-through-formatter
severity: MAJOR
languages: [javascript]
paths: ['src/**']
exclusions:
  - An ISO timestamp meant for a machine, such as toISOString in a log record or a file name, is outside this rule.
  - A date that is only compared or sorted, never shown, is outside this rule.
---

# Dates shown to people go through the shared formatter

A date shown to a person is formatted by formatDate from the shared formatter.

Joining date parts by hand, such as getDate and getMonth, is a finding.

Calling toLocaleDateString with a locale written inline is a finding.

An ISO timestamp meant for a machine, such as toISOString in a log record or a file name, is outside this rule.

A date that is only compared or sorted, never shown, is outside this rule.
