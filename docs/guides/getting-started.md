# Getting started

delta-peacock reviews pull requests against your team's own guidelines: markdown files versioned inside the repository being reviewed.

## First review in five steps

1. Install: `npx delta-peacock init` inside your repository. This writes a starter config, one example guideline, and a CI snippet, without touching anything that exists. Prefer questions over YAML? `npx delta-peacock init --walkthrough` asks about the SCM host, model provider, gating, context strategy, cost caps and guidelines location, explains the trade-off behind each, and writes the same files from your answers. Pressing enter at every question accepts the safe defaults and reproduces plain `init` exactly.
2. Set the model: put `id` under `model` in `delta-peacock.config.yaml` (or export `DELTA_PEACOCK_MODEL_ID`), and export the provider credential, for anthropic that is `ANTHROPIC_API_KEY`.
3. Check the setup: `npx delta-peacock doctor` validates config, git state, guidelines, model and SCM reachability with actionable messages.
4. Write guidelines under `guidelines/`: one markdown file per guideline with `id` and `severity` frontmatter. `npx delta-peacock guidelines lint` keeps the corpus honest.
5. Review locally: `npx delta-peacock review` in a branch prints findings to the terminal and never touches a PR. Add `--report review.json` for the machine-readable version.

## Posting on pull requests

Set the SCM once your CI runs it (see the [CI recipes](ci-recipes.md)):

```yaml
scm:
  provider: github # or gitlab, bitbucket
  repository: owner/repo
```

The PR number and tokens come from the environment (`DELTA_PEACOCK_SCM_PULL_REQUEST`, `GITHUB_TOKEN`, `GITLAB_TOKEN` or `BITBUCKET_TOKEN`). Comments are idempotent: re-runs update or resolve, never duplicate. `--dry-run` guarantees nothing is posted even with everything configured.

## Gating

The default posture is advisory: findings inform and the build never fails. To gate, set a threshold:

```yaml
gate:
  failOn: CRITICAL
```

Exit codes: 0 clean or advisory, 1 tool error, 2 findings at or above the threshold.

## Costs

Set `cost` rates for your model and, optionally, caps: `maxPerReview` blocks a single expensive review before any model call; `monthlyCap` tracks cumulative spend through a local counter (or AWS Cost Explorer for Bedrock).
