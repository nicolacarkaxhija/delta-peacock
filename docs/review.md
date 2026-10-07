# Review

delta-peacock reviews its own pull requests against the rules in `guidelines/`, configured by
`delta-peacock.config.yaml` at the root. A finding cites a guideline and takes its severity;
`gate.failOn` decides which severities fail. The review is advisory in `dogfood.yml`
(`continue-on-error`), so it never blocks a merge.

## Guidelines

One file per rule in `guidelines/`, with the frontmatter `id`, `severity`, `languages` and `paths`,
a heading that states the rule, one paragraph of reason, then a Good and a Bad example. The
reviewer reads them from the target branch, so a pull request cannot weaken the rules that judge
it. `natural-comments` is bound to the `comments` check under `review.checks`, so it quotes the
check's sentences word for word; `no-magic-numbers` and `conventional-titles` are judged by the
model.

## The workflow

`.github/workflows/dogfood.yml` builds the reviewer from the pull request and runs it with the
scm, the model and the cost caps from its environment: Anthropic's Sonnet 4.5 with a 0.10 USD cap
per review. The config leaves those three out on purpose, since two tests load it from the
repository root and expect the defaults.
GitHub Actions are off on the owner's account for now, so the review is dormant until they are
switched back on and the secret below exists.

When the model cannot run (no credential, an outage, a rate limit, a timeout, a refused key), the
review checks facts only with the default `fallback` settings. The only checked guideline here,
`natural-comments`, is `MINOR`, so no fact reaches `gate.failOn: MAJOR`: the step passes with the
status `Facts only, no model: needs a person's approval`, and the summary asks for that approval. See
[when the model cannot run](guides/checks.md#when-the-model-cannot-run).

| Secret                                                     | For                                                 |
| ---------------------------------------------------------- | --------------------------------------------------- |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | the model calls of `dogfood.yml`, on Amazon Bedrock |
| `GITHUB_TOKEN`                                             | the workflow's own token posts the comments         |

To review on Amazon Bedrock as the reference configuration does, set `DELTA_PEACOCK_MODEL_PROVIDER` to
`bedrock` and `DELTA_PEACOCK_MODEL_ID` to `eu.anthropic.claude-sonnet-4-5-20250929-v1:0` in
`dogfood.yml`, and pass `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_REGION`
(`eu-central-1`) as secrets.

## Running it locally

```sh
pnpm build
node dist/cli.js review --staged   # the index against HEAD, nothing posted
```
