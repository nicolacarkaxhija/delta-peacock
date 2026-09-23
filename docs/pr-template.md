## What

> The change in one or two sentences; the title already names it.

## Why

> The reason: the ticket, the risk it covers or the bug it fixes.

## How to test

> The command that shows it works, run from a clean checkout.

## Evidence

> Optional: a report, a screenshot, a log or the pipeline run. Delete this section when there is none.

## Checklist

- [ ] One behavior per pull request, and no other pull request of mine is open
- [ ] Every new criterion is an executable check in `docs/acceptance.md`
- [ ] Docs touched by this change are updated (specs, ADRs, glossary, registries)
- [ ] New behavior is covered by tests written at the agreed seams
- [ ] No secrets: no password, token or `.env` value in the diff or here
