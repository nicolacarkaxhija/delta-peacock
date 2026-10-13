---
id: known-failures-need-a-ticket
severity: MAJOR
languages: [typescript]
paths: ['tests/**']
---

# A test that is known to fail names its ticket, never a bare skip

A test that is known to fail calls `knownFailure('<ticket>', '<owner>', '<expiry>')`, so the expectation lapses instead of hiding a defect for good.

A skip decided by the configuration, for a screen or a feature a tenant does not have, marks no failure and needs no ticket; a skip decided by what the app answered hides a defect the day the screen breaks, and is never allowed.

A dated mute is the second allowed form, for a fault seen on one tenant while it is investigated: a `test.skip` on a `<tenant>.<feature>Muted` setting whose reason names the fault and ends with `until <date>`, the date the setting expires.

Flag every other skip of a failing test: one without an expiry date, one whose reason leaves out the fault or the date, one keyed to every tenant.

Good:

```ts
knownFailure('NOTES-88', 'the sync team', '2026-12-01');

// this tenant has no archive screen, so there is nothing to test
test.skip(!settings.hasScreen('archive'), 'archive is not part of this tenant');

test.skip(settings.muted('exportMuted'), 'tenant b drops emoji on export; muted until 2026-11-20');
```

Bad:

```ts
test.skip('export keeps emoji', async () => {
test.skip(app.currentPath().endsWith('/not-found'), 'the screen answers not found');
test.skip(settings.muted('exportMuted'), 'muted for now');
```
