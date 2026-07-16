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

Clone fully (no shallow clone) so the merge base resolves; when it cannot, the reviewer falls back to the SCM's own PR diff with a notice, and incremental features degrade. Pass `DELTA_PEACOCK_REVIEW_LAST_REVIEWED_COMMIT` (the last green commit) to review only new changes on re-pushes.
