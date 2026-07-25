---
id: validate-external-input
severity: MAJOR
---

# Validate and bound external input

Data crossing a trust boundary (request bodies, query parameters, headers,
file uploads, message payloads) must be validated against an explicit schema
and bounded in size before use. Reject what does not match; never trust shape
or length.
