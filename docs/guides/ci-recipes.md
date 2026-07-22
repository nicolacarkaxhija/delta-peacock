# CI recipes

Every recipe needs a full clone (the diff comes from local git) and the model credential in the environment. The Docker image `ghcr.io/nicolacarkaxhija/delta-peacock` carries node and git; the npm package runs wherever node 20+ does.

## GitHub Actions

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
            - npx delta-peacock review
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

Clone fully (no shallow clone) so the merge base resolves; when it cannot, the reviewer falls back to the SCM's own PR diff with a notice, and incremental features degrade. Pass `DELTA_PEACOCK_REVIEW_LAST_REVIEWED_COMMIT` (the last green commit) to review only new changes on re-pushes.
