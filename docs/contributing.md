# Contributing

How a change reaches `main`: the branch it lives on, the pull request that carries it, and the
checks on the way. The words the code and docs use are in [CONTEXT.md](../CONTEXT.md).

## Branches

- `main` is the trunk and the only long lived branch. Changes reach it through a pull request;
  release-please's release commits are the one exception.
- Every change is a short branch off `main`, named `<type>/<slug>` or `<type>/<TICKET-KEY>-<slug>`.
  The type is one of `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `perf`, `ci`, `build`. The
  slug is lowercase words joined by hyphens.
  - `feat/bedrock-cache-rates`
  - `fix/placement-off-by-one`
  - `chore/project-baseline`
- One pull request at a time: finish, merge or close the open one before starting the next.
- Keep it small: one behavior, one fix or one bump per branch, merged within days.
- A branch with no commit for 14 days is stale: rebase it onto `main` and finish it, or close it.
  `sh scripts/stale-branches.sh` lists them.

## Commits

One subject line per commit, `type(scope): summary`, no body and no trailer. The scope is optional
and names the area the change touches, such as `checks`, `review`, `scm` or `config`. A `!` after
the type or scope marks a breaking change. `feat` and `fix` subjects become release-please's
changelog lines, so write them for a reader of the changelog.

## Pull requests

- The title follows the commit rule, with a ticket key once at the end after a comma when there
  is one. It becomes the one commit on `main`, so write it as that commit's subject.
- The description has five sections: What, Why, How to test, Evidence (optional) and Checklist.
  [`pr-template.md`](pr-template.md) is the text to start from; GitHub fills it in from
  `.github/pull_request_template.md`. Every section but Evidence must say something; hint lines
  starting with `>` do not count.
- Merging squashes the branch into one commit whose message is the title, and deletes the branch.

## Checks and where they run

On the laptop, through husky (`pnpm install` wires it; husky owns `core.hooksPath`):

- `pre-commit`: lint-staged (eslint and prettier on the staged files), then `pnpm typecheck`.
- `commit-msg`: commitlint's conventional rule, then `.githooks/commit-msg`: one line, no trailer,
  no dash as punctuation.
- `pre-push`: `.githooks/pre-push` runs `scripts/pr-check.mjs --local` on the branch name and the
  last subject, then `pnpm lint`, `pnpm format:check`, `pnpm spell` and `pnpm typecheck`.

In GitHub Actions: `ci.yml` (format, lint, typecheck, coverage, build, docs integrity, commitlint,
gitleaks), `dogfood.yml` (the reviewer reviews its own pull request, see [review.md](review.md)),
plus `bench-smoke.yml`, `pages.yml` and `release-please.yml`. Actions are off on the owner's
account for now, so none of these runs until they are switched back on; the hooks and
[acceptance.md](acceptance.md) carry the checks meanwhile. `ci/github-pr.yml` is the pr-check job
as a template, to copy into `.github/workflows/` when Actions return.

A red check names the rule it applied. Fix the title or the description, then rerun the job.

## Settings an admin makes once

Allow only squash merging, default the squash message to the pull request title, turn on
automatic deletion of head branches, protect `main`. `sh scripts/github-settings.sh
nicolacarkaxhija/delta-peacock` applies all but the protection rule.
