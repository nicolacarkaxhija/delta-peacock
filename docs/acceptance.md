# Acceptance checks

Every criterion this repository promises, each with the one command that proves it. A criterion
lives here the day it is agreed, never only in a chat or a ticket. A release runs the whole list
from a clean checkout; a red line blocks it.

## Hooks and pull request

- `commit subject`: every commit is one conventional line with no trailer. On its own:
  `git log -1 --format=%B | pnpm exec commitlint && git log -1 --format=%B | sh .githooks/commit-msg /dev/stdin`.
- `branch and last subject`: the branch and the last subject follow docs/contributing.md. On its
  own: `node scripts/pr-check.mjs --local`.
- `format`: every file matches prettier. On its own: `pnpm format:check`.
- `lint`: eslint with the strict type-aware rules. On its own: `pnpm lint`.
- `spell`: no unknown word outside `cspell.json`. On its own: `pnpm spell`.
- `typecheck`: tsc over the sources and tests. On its own: `pnpm typecheck`.
- `tests at the bar`: vitest passes with 95 % lines, branches, functions and statements. On its
  own: `pnpm test:coverage`.
- `docs integrity`: every doc is in its directory's INDEX.md and every relative link resolves. On
  its own: `pnpm docs:check`.
- `secrets`: gitleaks finds nothing outside the documented fixtures. On its own:
  `gitleaks detect --no-banner`.
- `review config`: the configuration validates and every guideline is usable. On its own: `pnpm build && node dist/cli.js doctor` ends with `all checks passed`.

## Release

- `clean checkout`: the release starts from a fresh clone of `main`. On its own:
  `git status --porcelain` prints nothing and `git rev-parse HEAD` equals `origin/main`.
- `build`: the bundle builds and answers. On its own: `pnpm build && node dist/cli.js --version`.
- `offline tarball`: the bundled tarball installs with the network off. On its own:
  `pnpm pack:bundled`, then `npm install --ignore-scripts --no-save ./delta-peacock-<version>.tgz`
  in an empty directory and `npx --no-install delta-peacock --version`.
- `bench`: mean F1 over `bench/cases` does not fall against the previous release. On its own: the
  bench command in [release-checklist.md](guides/release-checklist.md), step 2.
