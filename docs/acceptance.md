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
- `review config`: the configuration validates and every bound guideline quotes its check's
  sentence. On its own: `pnpm build && node dist/cli.js doctor` ends with `all checks passed`.
- `packs agree with the checks`: every sentence a static check quotes is said by a shipped pack
  rule, every check owns one, every other pack rule is marked `judged`, and every shipped pack
  lints clean. On its own: `pnpm exec vitest run tests/pack-rules.test.ts tests/pack-lint.test.ts`.
- `pack facts on the bench`: with no model the bench finds every planted breach of a pack rule a
  check owns and exits 0, its aggregate at 100 % precision and recall. The aggregate counts only the
  breaches a check owns; the breaches of judged rules are not found and count under
  `judgement`. On its own:
  `pnpm build && node dist/cli.js bench --cases bench/cases --provider none`.
- `facts only`: with `model.provider: none` no model port is ever built or called, a candidate
  that needs a judgement is left to a person, and every command that needs a model refuses with
  one line and exit code 1. On its own: `pnpm exec vitest run tests/facts-`.
- `model fallback`: a review whose model is not configured, unreachable, rate or quota limited,
  timed out or refused its credential checks facts only, exits 0 unless a fact finding fails the
  gate, and posts a status and a summary that ask for a person's approval; `fallback.gate`,
  `fallback.status` and `fallback.credentialRefused` each behave as documented in both values; a
  fallback leaves earlier comments as they are, keeps the answered batches, asks the judge once
  per run and times a silent provider out after `model.timeoutSeconds`; a review with a working
  model posts and exits as before. On its own:
  `pnpm exec vitest run tests/model-fallback`.
- `exclusions`: a guideline's `exclusions` must be sentences it says word for word; a finding
  under it is dropped only when the exclusion check copies a listed case, and kept on any other
  answer, an unreadable one or a failed call. On its own: `pnpm exec vitest run tests/exclusions`.
- `findings on changed lines`: a model finding whose span touches no added or edited line is
  dropped before the exclusion check and counted in the report, the log, the summary comment and
  the backtest, unless its guideline declares `scope: file`. On its own:
  `pnpm exec vitest run tests/changed-lines tests/backtest.test.ts`.
- `batch cost`: a change reviewed in batches sends no more input tokens than the same files
  reviewed as separate changes, each batch carries only its own files' context, the shared prefix
  carries a cache marker on Anthropic and on Anthropic models on Bedrock, and no cached token is
  priced twice. On its own:
  `pnpm exec vitest run tests/batch-cost tests/anthropic-adapter tests/model-providers`.
- `facts under a cost cap`: a review the cost guard stops makes no model call, posts and counts
  its fact findings, gates on them and says the cost cap stopped the model. On its own:
  `pnpm exec vitest run tests/quality-018 tests/cost-guard`.
- `cost cap on actual spend`: a review refuses every model call once the actual cost of its replies
  reaches `cost.maxPerReview` or what is left of `cost.monthlyCap`, keeps the findings of the calls
  that answered, names the files no model reviewed and records the spend in `budget.stopped`; no
  estimate blocks a single model review before its first call. On its own:
  `pnpm exec vitest run tests/cost-ceiling tests/cost-guard`.
- `linked references`: every commit, file and line, guideline and finding comment the reviewer
  writes is a link where the host can build its address and plain text where it cannot; a task
  text stays plain; comments and summaries an earlier version wrote are claimed and updated in
  place with no second comment or task. On its own:
  `pnpm exec vitest run tests/linked-references tests/guideline-sources`.

## Release

- `clean checkout`: the release starts from a fresh clone of `main`. On its own:
  `git status --porcelain` prints nothing and `git rev-parse HEAD` equals `origin/main`.
- `build`: the bundle builds and answers. On its own: `pnpm build && node dist/cli.js --version`.
- `offline tarball`: the bundled tarball installs with the network off. On its own:
  `pnpm pack:bundled`, then `npm install --ignore-scripts --no-save ./delta-peacock-<version>.tgz`
  in an empty directory and `npx --no-install delta-peacock --version`.
- `bench`: mean F1 over `bench/cases` does not fall against the previous release. On its own: the
  bench command in [release-checklist.md](guides/release-checklist.md), step 2.
- `backtest`: every consumer case passes with zero wrong findings, zero drift and recall at or
  above the stored baseline. On its own: `delta-peacock backtest --cases <cases>`, see
  [backtest.md](guides/backtest.md).
- `backtest anchor window`: with `--anchor-window <lines>` a finding that many lines beside an
  expected span counts as right and goes to the nearest span; 0 keeps the exact span. On its own:
  `pnpm exec vitest run tests/backtest.test.ts`.
