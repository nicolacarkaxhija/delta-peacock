<div align="center">

# delta-peacock

### The code review that enforces your rules, not an LLM's opinion.

**Your guidelines. Any SCM. Any model. One deterministic exit code.**

[![tests](https://img.shields.io/badge/tests-606%20passing-1fb6ba)](#development)
[![coverage](https://img.shields.io/badge/branch%20coverage-95%25-1fb6ba)](#development)
[![license](https://img.shields.io/badge/license-Apache--2.0-444)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-444)](#quick-start)
[![telemetry](https://img.shields.io/badge/telemetry-none-37c7a4)](#security-and-privacy)

</div>

---

Most AI reviewers answer one question: _what does a model think of this diff?_ delta-peacock answers a sharper one:

> **Does this change violate the rules your team wrote down, and should the build fail?**

It reviews pull requests against guidelines your team keeps as markdown in its own repository. Every finding cites the guideline it breaks and **inherits that guideline's severity**, so the model can never invent importance. The gate is a real exit code. There is no server, no account, and no telemetry: it runs as a single stateless CLI in any CI pipeline, or locally in your terminal without ever touching a pull request.

## Table of contents

- [Why delta-peacock](#why-delta-peacock)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [What ships](#what-ships)
- [Continuous integration](#continuous-integration)
- [Configuration](#configuration)
- [Security and privacy](#security-and-privacy)
- [How it compares](#how-it-compares)
- [Documentation](#documentation)
- [Development](#development)
- [License](#license)

## Why delta-peacock

The market is full of capable review assistants. None of them treats your written standards as an enforceable contract. That is the axis delta-peacock owns.

|                                                                               | delta-peacock | Typical AI reviewer     |
| ----------------------------------------------------------------------------- | ------------- | ----------------------- |
| Severity is set by **your** guideline and gates the build                     | Yes           | Model opinion, advisory |
| Guidelines read from the **target ref**, so a PR cannot weaken them           | Yes           | Rarely                  |
| Runs with no server, no telemetry, any local model                            | Yes           | SaaS, per seat          |
| Pre-flight per-review and monthly **spend caps**                              | Yes           | No budget concept       |
| Deterministic JSON report plus SARIF, GitLab Code Quality, Bitbucket Insights | Yes           | Comments only           |
| Idempotent comments via stable **fingerprints**                               | Yes           | Often duplicates        |
| Multi-model **ensemble** with judge reconciliation                            | Yes           | Single model            |

Position it as the **policy gate**, not the general assistant: for teams that already write standards down and want them enforced deterministically, self-hosted, on any model, with a spend ceiling.

## Quick start

Requires [Node.js](https://nodejs.org) 20 or newer.

```bash
# 1. Scaffold config, an example guideline, and a CI snippet for your host.
npx delta-peacock init          # or: init --walkthrough for guided setup
                                #     init --starter <pack> to seed from a curated pack

# 2. Point it at a model (any provider; a local one works too).
export DELTA_PEACOCK_MODEL_ID=claude-sonnet-4-5
export ANTHROPIC_API_KEY=...

# 3. Validate the whole install before spending a token.
npx delta-peacock doctor

# 4. Review the current branch. Exit 2 means a violation crossed your threshold.
npx delta-peacock review --fail-on MAJOR
```

A real review, gating a build:

```text
$ delta-peacock review --fail-on MAJOR
BLOCKER  src/config.js:3  [no-secrets-in-code] Hard-coded credential
         Move this token to an environment variable; never commit secrets.
MAJOR    src/config.js:6  [rhino-compat] Optional chaining unsupported on the SFCC backend
         Rhino does not support ?.; use an explicit guard.

2 finding(s)
gate: failOn=MAJOR FAILED (2 at or above threshold)   # exit code 2
```

## How it works

**Guidelines are the contract.** A guideline is a markdown file with a small frontmatter header, versioned inside the repo it governs:

```markdown
---
id: no-secrets-in-code
severity: BLOCKER
languages: [javascript]
paths: ["src/**"]
---

# No secrets in committed code

Credentials, tokens and API keys must come from the environment, never a literal in source.
```

**Tamper resistance.** By default the corpus is read from the **merge target**, so a pull request cannot weaken the rules that judge it. Language and path scoping keep each rule to the files it governs, and a violation citing a guideline whose scope excludes the flagged file is dropped deterministically.

**A gate, not a suggestion box.** Findings are compared against your `failOn` threshold. The exit code is the outcome: `0` clean or advisory, `1` a tool error, `2` a gate failure. Nothing is guessed.

**Auditable by construction.** Comments carry a stable fingerprint marker, so re-runs update or resolve rather than duplicate. The JSON report is a plain artifact you can diff, archive, or feed into other tools, and it also renders to SARIF, GitLab Code Quality, and Bitbucket Code Insights.

## What ships

**Source control.** GitHub, GitLab, and Bitbucket Cloud adapters plus a local mode. Idempotent inline and summary comments, native suggestion blocks, commit statuses, Bitbucket Code Insights, and a hard `--dry-run` that never emits a single outbound request.

**Models.** Anthropic, Amazon Bedrock, OpenRouter, and any OpenAI-compatible host including local models (Ollama, vLLM). Multi-model **ensemble** review with union or judge merging.

**Cross-file awareness.** A zero-cost deterministic repo map by default, on-demand agentic tools, and retrieval that runs on lexical TF-IDF or real embeddings behind a pluggable port. Strategies layer, and a prompt budget ledger keeps the assembled request inside the model's window, degrading in a documented order.

**Governance and cost.** An in-process cost guard with per-review and monthly spend caps checked against real usage, secret and PII redaction before anything reaches a model, an optional response cache for re-triggered runs, and a stable prompt prefix so provider-side caching keeps hitting.

**The command surface** (`delta-peacock --help`):

| Command      | What it does                                                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `review`     | Gate a branch against its guidelines. `--staged` for pre-commit, `--bootstrap` for an empty corpus, `--write-baseline` to adopt on legacy code. |
| `audit`      | Review the whole tree, not just a diff.                                                                                                         |
| `describe`   | Generate the PR description from the change, idempotently.                                                                                      |
| `ask`        | Question the changeset in the terminal, one-shot or a session.                                                                                  |
| `fix`        | Apply report suggestions to the working tree or a patch file.                                                                                   |
| `learn`      | Turn team reactions into proposed guideline drafts.                                                                                             |
| `stats`      | Per-contributor findings, normalized per changed line. A coaching aid.                                                                          |
| `guidelines` | `lint`, coverage `stats`, `pack` authoring, and legacy `import`.                                                                                |
| `doctor`     | Validate the whole install without reviewing anything.                                                                                          |
| `init`       | Scaffold config, a guideline, and a CI snippet. `--walkthrough`, `--starter`.                                                                   |
| `bench`      | Score the reviewer against benchmark cases.                                                                                                     |
| `config`     | Resolve and print the effective configuration.                                                                                                  |

## Continuous integration

GitHub Actions, gating pull requests:

```yaml
name: delta-peacock
on: pull_request
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 } # full clone so the merge base resolves
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: npx delta-peacock review --fail-on MAJOR
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          DELTA_PEACOCK_SCM_PROVIDER: github
          DELTA_PEACOCK_SCM_REPOSITORY: ${{ github.repository }}
          DELTA_PEACOCK_SCM_PULL_REQUEST: ${{ github.event.pull_request.number }}
```

GitLab CI and Bitbucket Pipelines recipes, a Jenkins snippet, code-scanning artifacts, and a pre-commit hook (`review --staged`) are in the [CI recipes guide](docs/guides/ci-recipes.md).

## Configuration

Configuration is layered: built-in defaults, then a `delta-peacock.config.yaml`, then `DELTA_PEACOCK_*` environment variables, then CLI flags. Secrets never live in the config file; they come from the environment. A JSON Schema ships for editor autocomplete, and `delta-peacock config` prints the effective result.

```yaml
model:
  provider: anthropic
review:
  target: main
  guidelinesDir: guidelines
gate:
  failOn: MAJOR
cost:
  maxPerReview: 0.50 # block a review estimated above this, before any model call
```


## Security and privacy

- **No telemetry, no phone home.** Nothing about your code or your review leaves the process except the model call you configured.
- **Secrets never in config.** Credentials are read from the environment only, and the loader flags credential-shaped values that slip into config.
- **Redaction before the model.** Secret and PII patterns are stripped from the diff before it is ever sent, with the counts recorded in the report.
- **The dry-run guarantee.** `--dry-run` is enforced before any adapter is built: no comment, status, or write of any kind is emitted, whatever is configured.
- **Bring your own model.** Point it at a local endpoint and no code leaves your network at all.

## How it compares

delta-peacock is deliberately not the chattiest assistant. Tools like Qodo Merge, CodeRabbit, and Kodus offer richer interactivity and more platform breadth. What none of them offers is your written standards as a deterministic gate: severity as policy rather than model opinion, guidelines that a pull request cannot weaken, self-hosting on any model, and a spend ceiling. If that is the gap you need filled, this is the tool that fills it.

## Documentation

| Guide                                             | Read it when                                               |
| ------------------------------------------------- | ---------------------------------------------------------- |
| [Getting started](docs/guides/getting-started.md) | Your first review, in five steps                           |
| [CI recipes](docs/guides/ci-recipes.md)           | Wiring into GitHub, GitLab, Bitbucket, Jenkins, pre-commit |
| [Guideline packs](docs/guides/packs.md)           | Sharing and importing guideline sets                       |

## Development

```bash
pnpm install
pnpm test          # unit tests
pnpm test:coverage # with the 95% coverage gate
pnpm lint && pnpm typecheck
pnpm build         # bundle the CLI to dist/
node dist/cli.js --version
```

Commits follow the [conventional commit](https://www.conventionalcommits.org) format, enforced by a hook; the changelog and versioning are generated from them. Contributions are welcome: open an issue to discuss a change, keep the coverage gate green, and match the docs registries.

## License

[Apache-2.0](LICENSE).
