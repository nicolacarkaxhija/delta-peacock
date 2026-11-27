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
- `semgrep pre pass`: a rule match on a changed line is a finding with producer semgrep in the
  report, the findings file and Code Insights; the model prompt leaves out the guideline the rule
  settles and the hunk it settles; a clean hunk reaches the model unchanged; `semgrep.enabled:
false` restores the review without the pre pass; a Semgrep failure warns and sends the whole
  diff. On its own: `pnpm exec vitest run tests/semgrep-`.
- `semgrep rules`: every shipped rule flags its violating fixture and passes its clean one on the
  pinned Semgrep, carries its pack version and changes only with a new pack version, and each
  rule's backtest case passes with no model. On its own: `pnpm build && node scripts/semgrep-install.mjs`, then
  `pnpm exec vitest run tests/semgrep-packs.test.ts`, then `pnpm build` and
  `PATH="$(node scripts/semgrep-install.mjs):$PATH" node dist/cli.js backtest --cases bench/backtest --only semgrep-logger-assigned-once,semgrep-no-new-cartridges,semgrep-test-ids-on-page-objects --provider none`.
- `pack facts on the bench`: with no model the bench finds every planted breach of a pack rule a
  check owns and exits 0, its aggregate at 100 % precision and recall. The aggregate counts only the
  breaches a check owns; the breaches of judged rules are not found and count under
  `judgement`. On its own:
  `pnpm build && node dist/cli.js bench --cases bench/cases --provider none`.
- `facts only`: with `model.provider: none` no model port is ever built or called, a candidate
  that needs a judgement is left to a person, and every command that needs a model refuses with
  one line and exit code 1. On its own: `pnpm exec vitest run tests/facts-`.
- `taxonomy tags`: the tag check accepts `@<dimension>:<value>` for every value the consumer config
  lists under `taxonomy.dimensions`, the engine risk scale, `@feature:<feature>` and `unclassified`
  on a required dimension, and any value of an axis or a dimension the config builds in code; a
  tag none of these declare is still a finding. On its own: `pnpm exec vitest run tests/taxonomy-tags`,
  then `pnpm build && node dist/cli.js backtest --cases bench/backtest --only axis-tags-taxonomy-and-built-sites-compliant --provider none`.
- `model retry`: a model request that meets an unreachable provider, a rate or quota limit or a
  timeout is asked again with jittered exponential backoff, up to three attempts, and a refused
  credential is never asked again; by default a review whose model still cannot run posts the
  reason as its summary, a `failure` status and exits 1, a Bedrock 503 replayed on a local
  endpoint included. On its own: `pnpm exec vitest run tests/model-retry tests/model-fallback`.
- `model fallback`: a review whose model is not configured or refused its credential, or with
  `fallback.outage: fallback` is unreachable, rate or quota limited or timed out, checks facts
  only, exits 0 unless a fact finding fails the gate, and posts a status and a summary that ask for a person's approval; `fallback.gate`,
  `fallback.status` and `fallback.credentialRefused` each behave as documented in both values; a
  fallback leaves earlier comments as they are, keeps the answered batches, asks the judge once
  per run and times a silent provider out after `model.timeoutSeconds`; a review with a working
  model posts and exits as before. On its own:
  `pnpm exec vitest run tests/model-fallback`.
- `exclusions`: a guideline's `exclusions` must be sentences it says word for word; a finding
  under it is dropped only when the exclusion check names a listed sentence and kept on `none`;
  the verdict is asked as a structured reply whose schema holds only the listed sentences and
  `none`, then once as plain text; an unlisted sentence, an empty, blank or missing answer, an
  unreadable answer, a reply that ran out of output or a failed call holds the finding: never
  posted, recorded as `exclusion-unverified`, counted in the report's `exclusions` tally with the
  path that answered each verdict, named as held in the log and the summary (whose first line then
  never reads as clean), its earlier comment, thread and task left as they are; from
  `exclusions.warnHeldShare` of the checked findings the log and the summary warn that the review
  is incomplete, and the backtest lists held findings as a problem; a failed call's tokens count;
  the verdict runs at temperature 0, once per guideline, line text and list in a run, and on
  `exclusions.model` when set, priced at that model's rates; the review prompt carries each listed
  sentence once per guideline as a `Never report under this guideline` line; the synthetic case
  `exclusion-verdict-shapes` gives the same findings in three replays of each verdict shape. On
  its own: `pnpm exec vitest run tests/exclusions tests/held-findings tests/exclusion-verdict-backtest`.
- `verdict per sentence` (experimental): with `exclusions.verdict: each` the one verdict call
  numbers the listed sentences, leaves the reviewer's text out, frames the line as data and asks for
  the start of the trimmed line and a yes or no per sentence; any yes drops the finding under the
  first such sentence, all no keeps it, and a copy that is not a true start of the line or is
  does not cover the line's first lower bound characters, a
  skipped or reordered sentence or an answer other than yes or no holds it; the default `pick` asks
  as before; the report's `exclusionVerdicts` records each checked finding's sentence number, the
  answers under `each` and holds, never the model's words; the synthetic case
  `exclusion-verdict-each-sentence` drops its machine timestamp under `each` and posts it under
  `pick` with the recorded none. On its own:
  `pnpm exec vitest run tests/exclusions tests/exclusion-each-backtest`.
- `posting on evidence`: by default (`review.posting: confidence`) every finding under the
  confidence floor is held, as before; with `review.posting: evidence` a placed violation is posted
  whatever confidence the model gave it, a violation whose quote could not be placed is held, a
  model finding whose exclusion check was skipped is held unless a check found it too, a cited
  sentence must be a whole citable unit as `docs/guides/checks.md` defines it (markdown blocks: a
  paragraph's sentences, a whole list item or heading; example blocks and what a label covers,
  fenced and indented code, block quotes, comments, breaks, exclusion sentences, passages and near
  quotes are refused) or the finding is
  dropped as misquoted, the prompt asks the model to leave out what it is unsure of, an observation keeps
  the floor, and `audit` holds a violation whose guideline lists exclusions; replaying
  `exclusion-verdict-shapes` three times with a confidence that moves around the floor posts the
  same findings under `evidence` and drifts under `confidence`. On its own:
  `pnpm exec vitest run tests/posting tests/rule-sentences tests/evidence-gate-backtest tests/evidence-skipped-check tests/audit-posting`.
- `findings on changed lines`: a model finding whose span touches no added or edited line is
  dropped before the exclusion check and counted in the report, the log, the summary comment and
  the backtest, unless its guideline declares `scope: file`; a line that only changes the
  whitespace of a removed line of its hunk is not an edited line, and a finding on such lines alone
  is withheld as `reindented` and counted apart in the report, the log and the summary comment.
  On its own: `pnpm exec vitest run tests/changed-lines tests/git-diff tests/backtest.test.ts`.
- `unreadable replies`: every batch's prompt leaves the window room for the reply and a margin, a
  file over the batch budget is cut at its hunks, a reply with no readable JSON is asked again
  and then as two smaller slices, and the files still unread are named as not reviewed in the log,
  the report, the summary and the status, which follows `fallback.status` while `gate.failOn`
  still gates the reviewed files; the near-limit backtest case gets every batch answered, and the
  reasoning-fills-output-cap case gets every file reviewed after the doubled retry. On its
  own: `pnpm exec vitest run tests/budget-chunk tests/run-passes tests/unreviewed-files tests/near-limit-backtest tests/output-cap tests/output-cap-backtest tests/review-e2e tests/review-root-causes`.
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
- `already held`: a finding that asks its line to end with or hold a text the line already holds
  is dropped before anything is posted, and the log says why. On its own:
  `pnpm exec vitest run tests/already-held.test.ts`.
- `clean run line`: a run that finds nothing or has nothing to review leaves one line on the
  summary comment, created when missing and edited in place on every later push, naming the
  reviewed commit, the changed files, the files each include or exclude glob left out, the files an
  earlier review already covered and its commit; the commit status and the Insights card stay as
  they were. On its own:
  `pnpm exec vitest run tests/scm-render tests/review-root-causes tests/diff-hardening`.
- `linked references`: every commit, file and line, guideline and finding comment the reviewer
  writes is a link where the host can build its address and plain text where it cannot; a task
  text stays plain; comments and summaries an earlier version wrote are claimed and updated in
  place with no second comment or task. On its own:
  `pnpm exec vitest run tests/linked-references tests/guideline-sources`.
- `tasks at major`: a pull request task is created only for a finding at MAJOR or above; a MINOR
  or INFO finding posts its comment alone, and the reviewer resolves its own task once the finding
  falls below MAJOR. On its own: `pnpm exec vitest run tests/bitbucket-tasks`.
- `folded repeats`: above `scm.foldRepeatsAbove` findings (default 25) a rule that repeats keeps one
  inline comment, on its first finding, naming how many more places it matches, and the summary
  lists every finding; a 403 or a limit answer while posting inline comments stops the inline
  posting, and the review still posts its summary and status and names the findings left out;
  any other error still fails the step. On its own: `pnpm exec vitest run tests/comment-flood`.
- `accepted forms`: a finding whose tags or text match the repository's `accepted-forms.json`,
  read from the guidelines ref, is never posted, and the summary counts it as accepted; the
  synthetic `@not-site` and `@locale` cases replay a recorded false positive and post nothing.
  On its own: `pnpm exec vitest run tests/accepted-forms tests/scm-render`.
- `findings for the editor`: `review --findings <dir>` writes `<dir>/reviewer.json` that the
  vendored engine schema takes, one finding per placed finding outside the baseline with the producer
  `reviewer`, the guideline id as its rule, the mapped severity, a message quoting the guideline,
  the suggested change, a fingerprint of the guideline id, the flagged code and the guideline
  sentence that no wording, line or path changes, and the review record as evidence. On its own:
  `pnpm exec vitest run tests/findings-file`.
- `false positives become cases`: `backtest --intake <dir>` turns each false positive file of the
  reviewer into a case the loader picks up, with the recorded base and change and the finding as a
  `noFinding` entry, refuses a false positive whose fingerprint the record does not list, and names
  every file it skips with its reason; the case judges only the marked
  finding, and the review's other findings are neither wrong nor drift. On its own:
  `pnpm exec vitest run tests/findings-intake tests/score-unjudged`.
- `findings schema script`: the schema script passes an engine schema that says what the vendored
  copy says, fails on drift naming the refresh, refreshes the copy and validates a findings file.
  On its own: `pnpm exec vitest run tests/findings-schema-script`.

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
- `synthetic backtest`: every case in `bench/backtest` passes over three repeats with zero wrong
  findings and zero drift. On its own: `delta-peacock backtest --cases bench/backtest`.
- `findings schema in step`: the vendored findings schema says what the engine's says. On its
  own: the engine's `findings schema` output piped into `pnpm findings:schema check -`.
- `backtest anchor window`: with `--anchor-window <lines>` a finding that many lines beside an
  expected span counts as right and goes to the nearest span; 0 keeps the exact span. On its own:
  `pnpm exec vitest run tests/backtest.test.ts`.
- `pull request from the branch`: `config` and `guidelines lint` run under a provider with no
  pull request number; a GitHub review without one publishes to the one open pull request from
  the branch into the target, reads the branch from `GITHUB_HEAD_REF` then `GITHUB_REF_NAME` on a
  detached HEAD, says `no pull request for this branch` with the fork hint when there is none and
  still gates, and stops naming every match when there are several; a lookup refused with 401,
  403 or 404 fails the run without printing the token; any other provider still needs the number. On its own:
  `pnpm exec vitest run tests/pull-request-from-branch.test.ts tests/scm-github.test.ts tests/ambient-env.test.ts`.
