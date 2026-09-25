# CI recipes

Every recipe needs a full clone (the diff comes from local git) and the model credential in the environment. Each tagged release publishes a Docker image `ghcr.io/nicolacarkaxhija/delta-peacock` that carries node and git, plus an npm package that runs wherever node 22.12+ does. Pin the version in CI (`npx delta-peacock@0.1.3`) so a new release never changes a gate unannounced. The composite action below builds from source instead.

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
            - npx delta-peacock@0.1.3 review
          # set in repository variables:
          # ANTHROPIC_API_KEY, BITBUCKET_TOKEN, DELTA_PEACOCK_MODEL_ID
          # DELTA_PEACOCK_SCM_PROVIDER=bitbucket
          # DELTA_PEACOCK_SCM_REPOSITORY=$BITBUCKET_WORKSPACE/$BITBUCKET_REPO_SLUG
          # DELTA_PEACOCK_SCM_PULL_REQUEST=$BITBUCKET_PR_ID
          # DELTA_PEACOCK_REVIEW_TARGET=$BITBUCKET_PR_DESTINATION_BRANCH
```

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

On Bitbucket the native equivalent is Code Insights: `DELTA_PEACOCK_SCM_CODE_INSIGHTS=true` publishes a report card with the gate result plus inline annotations upserted by finding fingerprint. Pair it with `DELTA_PEACOCK_SCM_COMMENTS=false` for a commentless review that still gates and annotates. Workspaces with insights disabled degrade to a notice, never a failed review.

## Pre-commit hook

`npx delta-peacock review --staged` reviews the index against HEAD: what you are about to commit, nothing more. It refuses any SCM configuration and the incremental anchor, and reads guidelines from the working tree (there is no target ref at commit time). A husky hook is one line:

```
npx delta-peacock review --staged --fail-on MAJOR
```

Clone fully (no shallow clone) so the merge base resolves; when it cannot, the reviewer falls back to the SCM's own PR diff with a notice, and incremental features degrade. Pass `--last-reviewed-commit <sha>` or `DELTA_PEACOCK_REVIEW_LAST_REVIEWED_COMMIT` (the last green commit) to review only new changes on re-pushes.

## Air-gapped runners

The npm tarball bundles its runtime dependencies, so a runner with no registry access installs a vendored copy directly: `npm install --ignore-scripts --no-save ./delta-peacock-<version>.tgz`, then run `node_modules/.bin/delta-peacock`. The model endpoint and the SCM API still need to be reachable for a posting review.
