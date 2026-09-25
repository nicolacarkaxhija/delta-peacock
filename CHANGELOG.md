# Changelog

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
