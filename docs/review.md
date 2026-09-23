# Review

delta-peacock reviews its own pull requests against the rules in `guidelines/`, configured by
`delta-peacock.config.yaml` at the root. A finding cites a guideline and takes its severity;
`gate.failOn` decides which severities fail. The review is advisory in `dogfood.yml`
(`continue-on-error`), so it never blocks a merge.

## Guidelines

One file per rule in `guidelines/`, with the frontmatter `id`, `severity`, `languages` and `paths`,
a heading that states the rule, one paragraph of reason, then a Good and a Bad example. The
reviewer reads them from the target branch, so a pull request cannot weaken the rules that judge
it. The model judges all three: `natural-comments`, `no-magic-numbers` and `conventional-titles`.

## The workflow

`.github/workflows/dogfood.yml` builds the reviewer from the pull request and runs it with the
scm, the model and the cost caps from its environment: Anthropic's Haiku 4.5 with a 0.10 USD cap
per review. The config leaves those three out on purpose, since two tests load it from the
repository root and expect the defaults.
GitHub Actions are off on the owner's account for now, so the review is dormant until they are
switched back on and the secret below exists.

| Secret              | For                                         |
| ------------------- | ------------------------------------------- |
| `ANTHROPIC_API_KEY` | the model calls of `dogfood.yml`            |
| `GITHUB_TOKEN`      | the workflow's own token posts the comments |

To review on Amazon Bedrock as the project baseline does, set `DELTA_PEACOCK_MODEL_PROVIDER` to
`bedrock` and `DELTA_PEACOCK_MODEL_ID` to `eu.anthropic.claude-haiku-4-5-20251001-v1:0` in
`dogfood.yml`, and pass `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_REGION`
(`eu-central-1`) as secrets.

## Running it locally

```sh
pnpm build
node dist/cli.js review --staged   # the index against HEAD, nothing posted
```
