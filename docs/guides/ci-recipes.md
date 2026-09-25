# CI recipes

Every recipe needs a full clone (the diff comes from local git) and the model credential in the environment. Each tagged release publishes a Docker image `ghcr.io/nicolacarkaxhija/delta-peacock` that carries node and git, plus an npm package that runs wherever node 22.12+ does. Pin the version in CI (`npx delta-peacock@0.1.7`) so a new release never changes a gate unannounced. The composite action below builds from source instead.

## GitHub Action (one line)

The repository ships a composite Action, so the whole recipe collapses to a single `uses:`. It builds the reviewer from source, auto-wires the pull request context, and routes your model key to the right provider variable.

```yaml
name: review
on: pull_request
jobs:
  delta-peacock:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: nicolacarkaxhija/delta-peacock@v1
        with:
          fail-on: MAJOR
          provider: anthropic
          model: claude-sonnet-4-5
          api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          sarif: findings.sarif # optional: upload to code scanning
      - if: always()
        uses: github/codeql-action/upload-sarif@v3
        with: { sarif_file: findings.sarif }
```

Set `post: false` to run local-only (no comments, gate exit code only). Every input is documented in [`action.yml`](../../action.yml).

## GitHub Actions (explicit)

```yaml
name: review
on: pull_request
permissions:
  pull-requests: write
  statuses: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npx delta-peacock review
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          DELTA_PEACOCK_MODEL_ID: claude-haiku-4-5-20251001
          DELTA_PEACOCK_SCM_PROVIDER: github
          DELTA_PEACOCK_SCM_REPOSITORY: ${{ github.repository }}
          DELTA_PEACOCK_SCM_PULL_REQUEST: ${{ github.event.pull_request.number }}
          DELTA_PEACOCK_REVIEW_TARGET: ${{ github.event.pull_request.base.ref }}
```

## GitLab CI

```yaml
delta-peacock-review:
  image: node:24
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  variables:
    GIT_DEPTH: 0
  script:
    - export DELTA_PEACOCK_SCM_PROVIDER=gitlab
    - export DELTA_PEACOCK_SCM_REPOSITORY="$CI_PROJECT_PATH"
    - export DELTA_PEACOCK_SCM_PULL_REQUEST="$CI_MERGE_REQUEST_IID"
    - export DELTA_PEACOCK_REVIEW_TARGET="$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"
    - npx delta-peacock review
  # set as CI/CD variables: ANTHROPIC_API_KEY, GITLAB_TOKEN, DELTA_PEACOCK_MODEL_ID
```

The token needs the `api` scope; a project access token works. Merge request pipelines must be enabled for `CI_MERGE_REQUEST_IID` to exist.

## Bitbucket Pipelines

```yaml
pipelines:
  pull-requests:
    "**":
      - step:
          name: delta-peacock review
          image: node:24
          clone:
            depth: full
          script:
            - npx delta-peacock@0.1.7 review
          # set in repository variables:
          # ANTHROPIC_API_KEY, BITBUCKET_TOKEN, DELTA_PEACOCK_MODEL_ID
          # DELTA_PEACOCK_SCM_PROVIDER=bitbucket
          # DELTA_PEACOCK_SCM_REPOSITORY=$BITBUCKET_WORKSPACE/$BITBUCKET_REPO_SLUG
          # DELTA_PEACOCK_SCM_PULL_REQUEST=$BITBUCKET_PR_ID
          # DELTA_PEACOCK_REVIEW_TARGET=$BITBUCKET_PR_DESTINATION_BRANCH
```

What each Bitbucket variable does:

| Variable                                                                                       | Where it comes from                                                                                    | Needed for                                                                                                                      |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `BITBUCKET_TOKEN`                                                                              | a repository access token with the Pull requests: Write scope, stored as a secured variable            | comments, the build status and the Code Insights report                                                                         |
| `DELTA_PEACOCK_SCM_PROVIDER`, `DELTA_PEACOCK_SCM_REPOSITORY`, `DELTA_PEACOCK_SCM_PULL_REQUEST` | the values above, from Bitbucket's own `BITBUCKET_WORKSPACE`, `BITBUCKET_REPO_SLUG`, `BITBUCKET_PR_ID` | knowing which pull request to review                                                                                            |
| `DELTA_PEACOCK_REVIEW_TARGET`                                                                  | `$BITBUCKET_PR_DESTINATION_BRANCH`                                                                     | the diff base, the branch guideline links point at, and the branch the guidelines and `delta-peacock.config.yaml` are read from |
| `BITBUCKET_BUILD_NUMBER`                                                                       | set by Pipelines                                                                                       | the build status links the pipeline run instead of the pull request                                                             |
| `DELTA_PEACOCK_SCM_CODE_INSIGHTS`                                                              | optional; `false` switches the report off                                                              | Code Insights is on by default for Bitbucket                                                                                    |
| `DELTA_PEACOCK_REVIEW_DISPLAY_NAME`                                                            | optional, or `review.displayName` in the config file                                                   | the name readers see on the status and report                                                                                   |
| `DELTA_PEACOCK_REVIEW_SUMMARY_WHEN_CLEAN`                                                      | optional, or `review.summaryWhenClean`; default `false`                                                | a summary comment on runs without findings                                                                                      |
| `DELTA_PEACOCK_SCM_TASKS`                                                                      | optional, or `scm.tasks`; default `false`                                                              | one pull request task per finding, resolved by the reviewer once the flagged line changes                                       |

The Code Insights report appears in the pull request's Reports panel with the display name as its title, `PASSED` or `FAILED` from the gate, the finding counts per severity, and one annotation per finding on its file and line, linked to the cited guideline; a finding that could not be tied to a line is annotated on its file. Since the card and the build status carry a clean result, a run without findings posts no summary comment unless `review.summaryWhenClean` is on; an earlier summary of the reviewer's is turned clean rather than left stale.

### Installing a committed release tarball

Until a package registry is in reach, a repository can commit the bundled tarball and its checksum file and install it offline. Check the tarball against the checksum file as the **target** branch holds it, so a pull request cannot bring its own tarball and a checksum to match:

```yaml
script:
  - git fetch origin "$BITBUCKET_PR_DESTINATION_BRANCH"
  - (cd tools && git show "origin/$BITBUCKET_PR_DESTINATION_BRANCH:tools/delta-peacock-0.1.7.tgz.sha256" | sha256sum -c -)
  - npm install --ignore-scripts --no-save --no-audit --no-fund ./tools/delta-peacock-0.1.7.tgz
  - npx --no-install delta-peacock review
```

The pull request that bumps the version adds a checksum the target does not hold yet, so that one run fails the check; a code owner merges it after reading the diff, and every later pull request passes. Bitbucket runs `bitbucket-pipelines.yml` from the pull request's own branch, so this closes the tarball path only together with code owner approval on the pipeline file and `tools/`.

## Jenkins

Any pipeline step works; a declarative example:

```groovy
stage('delta-peacock review') {
  when { changeRequest() }
  steps {
    sh '''
      export DELTA_PEACOCK_SCM_PROVIDER=bitbucket
      export DELTA_PEACOCK_SCM_REPOSITORY="$WORKSPACE_SLUG/$REPO_SLUG"
      export DELTA_PEACOCK_SCM_PULL_REQUEST="$CHANGE_ID"
      export DELTA_PEACOCK_REVIEW_TARGET="$CHANGE_TARGET"
      npx delta-peacock review
    '''
  }
}
```

## Code scanning artifacts

`DELTA_PEACOCK_OUTPUT_SARIF_PATH=findings.sarif` writes a SARIF 2.1.0 artifact; upload it on GitHub with `github/codeql-action/upload-sarif@v3` and findings land in the Security tab. `DELTA_PEACOCK_OUTPUT_CODE_QUALITY_PATH=code-quality.json` writes GitLab's Code Quality artifact; declare it under `artifacts:reports:codequality` and the MR widget diffs it between pipelines. Both are plain files: they work in dry run, local mode, and commentless setups.

On Bitbucket the native equivalent is Code Insights, published by default there (`DELTA_PEACOCK_SCM_CODE_INSIGHTS=false` turns it off): a report card with the gate result plus inline annotations upserted by finding fingerprint. Pair it with `DELTA_PEACOCK_SCM_COMMENTS=false` for a commentless review that still gates and annotates. Workspaces with insights disabled degrade to a notice, never a failed review.

## Pre-commit hook

`npx delta-peacock review --staged` reviews the index against HEAD: what you are about to commit, nothing more. It refuses any SCM configuration and the incremental anchor, and reads guidelines from the working tree (there is no target ref at commit time). A husky hook is one line:

```
npx delta-peacock review --staged --fail-on MAJOR
```

Clone fully (no shallow clone) so the merge base resolves; when it cannot, the reviewer falls back to the SCM's own PR diff with a notice, and incremental features degrade. Pass `--last-reviewed-commit <sha>` or `DELTA_PEACOCK_REVIEW_LAST_REVIEWED_COMMIT` (the last green commit) to review only new changes on re-pushes.

## Air-gapped runners

The npm tarball bundles its runtime dependencies, so a runner with no registry access installs a vendored copy directly: `npm install --ignore-scripts --no-save ./delta-peacock-<version>.tgz`, then run `node_modules/.bin/delta-peacock`. The model endpoint and the SCM API still need to be reachable for a posting review.

## The monthly cap in CI

`cost.maxPerReview` works anywhere: it compares one review's estimate with the cap before any model call. `cost.monthlyCap` needs the month's spend so far, and where that comes from matters in CI:

- `spendSource: counter` (the default) keeps a small JSON file, in the home directory unless `cost.counterPath` names another place. A CI runner starts from a clean container on every pipeline run, so the counter starts at zero every time and the monthly cap only ever sees the current review. It still works on a long lived runner or a developer machine.
- `spendSource: aws-cost-explorer` asks AWS Cost Explorer for the month to date spend of the account, which suits Bedrock. The credentials the review runs with need the `ce:GetCostAndUsage` permission; without it the reviewer warns and falls back to the counter. Cost Explorer reports the whole account's spend under the `Amazon Bedrock` service, lags by several hours, and each call costs 0.01 USD. Anthropic models on Bedrock can bill as AWS Marketplace line items with their own service names, so check in the Cost Explorer console that the `Amazon Bedrock` service carries the review spend before relying on this source.

A persistent counter through the SCM is possible but not built: on Bitbucket the pipeline could download the counter file from the repository's Downloads section (`GET` and `POST /2.0/repositories/{workspace}/{repo}/downloads`) before the review and upload it after, pointing `cost.counterPath` at it; pipeline caches and artifacts do not fit, since a cache is refreshed only weekly and an artifact lives only within one pipeline. Two pipelines running at once can lose one update that way, which a monthly cap tolerates.

## Debugging an unparsable reply

When a review stops with `every batch's reply failed to parse`, set `DELTA_PEACOCK_DUMP_REPLY=replies.jsonl`: every model call appends one JSON line with its finish reason and each step's text and tool calls. The file holds the model's own words about the redacted diff; keep it out of published artifacts.
