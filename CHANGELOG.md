# Changelog

## 0.1.7 (2026-09-25)

Root causes of the first reviewed pull requests on a Bitbucket consumer, each with a contract test.

### Bug Fixes

- The answering step after the last tool round sees the fetched files. Bedrock drops every tool call and result from a step that declares no tools, so the model answered from memory and invented a tag. That step is now one plain message: the review prompt, every fetched result as data, and the instruction that no further tool calls are allowed. The captured 0.1.4 reply fixture proves the request carries all six results.
- Every finding quotes its source line (`quote`). The reviewer looks the line up in the file at the reviewed commit and moves the finding there. A quote that is missing, absent from the file or found on several lines puts the finding in the summary with a note, never on a line it may not mean, and an Insights annotation on its file only. A suggestion replaces exactly the quoted line or is left out with a note. This replaces the backtick snippet relocation.
- Code that a guideline's own Good example shows verbatim is never a finding under that guideline; the prompt says so for structural matches too. A suggestion that names a tag the repository does not declare, or imports a file or package the repository does not have, is left out with a note.
- The declared feature tags and axis tags of the reviewed repository's `test-runner.config.ts` go into the prompt as the only tags that exist. The file is read as text, never run; `review.repoConfigPath` names another file, and an empty value turns it off.
- A reply with no JSON is asked once more, tools off, with the fetched files as text. If that fails too, or the model call fails, the summary says `The review could not complete: <reason>.` and the commit status fails, instead of the step exiting with no word on the pull request.
- `delta-peacock.config.yaml` is read from the target branch whenever the host names it (`DELTA_PEACOCK_REVIEW_TARGET` or `--target`), like the guidelines, so a pull request cannot loosen its own review. The working tree serves while the target has no config yet, and `DELTA_PEACOCK_CONFIG_FROM=source` keeps it for local runs.

### Wording

- One summary template for every outcome, opening with its verdict and no heading: `No issues found in this change.`, `Nothing in scope was changed.`, `The review could not complete: <reason>.`, or a count line with one line per finding. The display name stays in the commit status and the Insights report title only.
- Where an Insights card carries the result (Bitbucket), a run without findings posts no summary comment and only turns an earlier summary clean; `review.summaryWhenClean: true` posts it anyway.
- Finding titles and reasons lose dashes as punctuation, a trailing guideline id and openers such as "According to the guideline". The `Not posted` footnote names only what was actually held back.

### Documentation

- CI recipes: verify a committed release tarball against the checksum file from the target branch.

## 0.1.6 (2026-09-25)

### Bug Fixes

- Bitbucket shows no `<!-- delta-peacock:... -->` text anywhere. Inline comments are matched by author, file, line and the guideline id in their first line; a finding that persists updates its comment in place, and several findings on one line with one guideline keep their own comments across re-runs and reorders instead of being rewritten.
- A finding that is gone resolves its Bitbucket thread when someone replied, rather than deleting the discussion; it is deleted otherwise. A thread someone resolved is left alone and its finding is not posted again.
- `describe` on Bitbucket fences its section with a visible `### Change summary` heading and a closing `_Generated summary; replaced on every run._` line. A section written by an earlier version with hidden markers is replaced in place; GitHub and GitLab keep the hidden markers.

### Developer experience

- The fake Bitbucket refuses any comment or description write that contains `<!--`, so every Bitbucket test enforces the markerless contract.

## 0.1.5 (2026-09-25)

### Features

- `review.displayName` (default `Code review`) names the summary heading, the commit status on every host and the Bitbucket Code Insights report title, so the tool's own name never reaches the pull request's readers. `review.guidePath` (default `docs/reviews.md`) is linked from a blocked summary when the file exists.
- The summary reads `No issues found in this change.` when clean, otherwise a count line (`2 findings: 1 major, 1 minor`) and one line per finding. The gate appears only when it blocks (`Blocked: 1 major finding must be resolved.`); the commit status description says the same.
- Inline comments open with the severity as a bold word and the guideline id linked to `<guidelinesDir>/<id>.md` on the target branch, give the reason in at most two sentences, and fence a suggested change (one-click `suggestion` on GitHub, a plain block on Bitbucket).
- Code Insights publish by default on Bitbucket (`scm.codeInsights: false` opts out): the display name as title, `PASSED` or `FAILED`, a total plus per-severity counts, and one annotation per finding linked to its guideline. All-clear runs publish the report too.

### Bug Fixes

- Bitbucket printed the hidden `<!-- delta-peacock:... -->` markers as text. There the reviewer now recognises its own comments by author (the token's user) plus their fixed first line and posts no marker; a repository access token, which cannot call `GET /user`, learns its user from a draft comment deleted at once. Pre 0.1.5 summaries and inline comments are replaced in place, never duplicated. GitHub and GitLab keep the marker.
- `learn` and `stats --backfill` read the new comment format and Bitbucket's unmarked comments.
- An all-clear run honours `scm.comments: false`.

### Notices

- The GitHub status context and the GitLab status name change from `delta-peacock` to the display name; update a required status check that names the old one.

## 0.1.4 (2026-09-25)

### Bug Fixes

- The agentic context no longer ends a review mid-investigation: once `context.maxToolRounds` is spent the model gets one more step with tools switched off and is told to answer. Haiku 4.5 on a real Bitbucket pull request used all six rounds on tool calls, so the reply was prose with no JSON and the review failed with `every batch's reply failed to parse`.
- The reply parser takes the first findings object from anywhere in the reply, skipping braces in surrounding prose, and accepts a bare array of findings, fenced or not. An empty array inside prose never reads as a clean review.

### Developer experience

- `DELTA_PEACOCK_DUMP_REPLY=<file>` appends each raw model reply, step by step, as one JSON line.

## 0.1.3 (2026-09-25)

### Bug Fixes

- The Bitbucket build status carries the absolute `url` the real API requires (the pipeline run from `BITBUCKET_BUILD_NUMBER`, `BITBUCKET_WORKSPACE` and `BITBUCKET_REPO_SLUG`, else the pull request page) plus `name` and `refname`, so the POST no longer answers 400; unmapped SCM errors now quote the response body.

## 0.1.2 (2026-09-25)

### Features

- `bench` applies the structural verifier like `review` does, reading each case's `files/` tree. The scope-shaped bench guidelines (`SFRA-NO-CONST-IN-LOOP`, `SFRA-NO-TOP-REQUIRE`) opt in via `structural:`; the seed packs carry no scope-shaped rule. The reference bench (Bedrock Haiku 4.5, agentic context) scores 100% precision and recall.
- The npm tarball bundles every runtime dependency at its lockfile version and installs offline with `--ignore-scripts`. Build it with `pnpm pack:bundled`; the release workflow publishes that tarball.

### Bug Fixes

- `read_file_range` refuses symlinks and any path resolving outside the checkout, so a committed link to a file such as `/proc/self/environ` never reaches the model.
- The landing page closes `head` and opens `body`, so `pnpm format:check` passes.

### Developer experience

- Git hooks rerun `pnpm install` after a checkout or merge that changes `pnpm-lock.yaml`, and stay a no-op otherwise.
- A CodeTour (`.tours/getting-around.tour`) walks the review pipeline in the editor; `vsls-contrib.codetour` is a recommended extension.
- The bench cases 03 to 10 are synthetic storefront cases.

### Documentation

- README, guides and the landing page match the current CLI; the release checklist runs the reference bench and the offline tarball check instead of the live-smoke dispatch.

## 0.1.1 (2026-09-23)

### Tests

- Branch coverage gate restored: 95.56% of branches against the 95% gate, up from 93.99%.

## 0.1.0 (2026-09-23)

First npm release.

### Features

- `delta-peacock` CLI: `review`, `audit`, `describe`, `ask`, `fix`, `waive`, `learn`, `stats`, `guidelines`, `doctor`, `init`, `bench`, `config`.
- Guideline-anchored findings: each finding cites a markdown guideline and inherits its severity; the gate is a deterministic exit code (`0` pass, `1` tool error, `2` gate failure).
- Guidelines read from the merge target so a pull request cannot weaken them.
- SCM adapters for GitHub, GitLab and Bitbucket Cloud plus local mode, with idempotent fingerprinted comments and Bitbucket Code Insights.
- Model providers: Anthropic, Amazon Bedrock, OpenRouter and any OpenAI-compatible host, with multi-model ensemble review.
- Reports as JSON, SARIF 2.1.0 and GitLab Code Quality.
- Cost guard with per-review and monthly caps, secret and PII redaction, response cache, `--dry-run` guarantee.
- Curated starter packs (`security`, `typescript`) and the config JSON Schema ship in the package.

### Requirements

- Node.js 22.12 or newer.
