# Working in this repository

For any coding agent. The human rules live in [docs/contributing.md](docs/contributing.md); this
file adds what an agent forgets between sessions.

## Before you start

- Read `CONTEXT.md` for the terms, `docs/contributing.md` for the flow, `docs/acceptance.md` for
  what must stay green.
- Read the newest resume note (below) when one exists and continue from its next step.

## One pull request at a time

Open one pull request, drive it to green and hand it over before starting the next. Never stack a
second change on an unmerged branch unless the owner asks for it.

## Commits and pull requests

- Subject line only: `type(scope): summary`, no body, no trailer of any kind, no attribution line.
  The commit-msg hook refuses anything else; never bypass it with `--no-verify`.
- The pull request title is the commit rule with the ticket key last after a comma; the
  description follows `docs/pr-template.md`.
- No em dash, en dash or double hyphen as punctuation, in code, comments, docs or messages.
- Comments are one short line saying what the code cannot; never the session, the author or the
  story of the change.
- Never rewrite pushed history on a shared branch and never force push `main`.

## Evidence records

Every claim in a pull request or a hand over carries its evidence: the exact command, its exit
code, the commit it ran on and the numbers it printed (tests passed, coverage, timings). Paste the
output or link the run; "should work" is not evidence. A check you could not run is named as not
run, with the reason.

## Resume notes

Work that spans sessions leaves a resume note before the session ends, outside the repository
(the owner names the place), dated in the file name. It holds:

1. The goal in one line and the pull request or branch it lives on.
2. What is done, each item with its evidence.
3. What is open, and the next concrete step as a command.
4. Anything learned that the next session would otherwise rediscover.

Rewrite the note, never append a diary; the next session reads it first.
