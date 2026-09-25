---
id: known-issues-with-ticket
severity: MAJOR
languages: [typescript]
paths: ['tests/**', 'support/**']
---

# A known failure is a known issue with a ticket, never a skip

knownIssue in the spec, or an entry in support/known-issues.json for data rows, names the LP ticket, an owner and an expiry, so the expectation expires instead of hiding a defect forever.

Good:

```ts
knownIssue('LP-14310', 'Nicola Carkaxhija', '2026-10-23');
```

Bad:

```ts
test.skip('size guide opens', async () => {
```
