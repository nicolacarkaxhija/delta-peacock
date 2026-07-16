# delta-peacock

Guideline-anchored, provider-agnostic PR reviewer. Your rules, any SCM, any LLM.

**Status: pre-release.** The v1 feature set is implemented and tested; the first release is pending the final review pass. The product spec and work breakdown live in the [issue tracker](https://github.com/nicolacarkaxhija/delta-peacock/issues).

## What it does

delta-peacock reviews pull requests against your team's own guidelines: markdown files with a small frontmatter header, versioned inside the repository being reviewed. Every finding cites the guideline it violates and inherits that guideline's severity, so the model cannot invent importance. It runs as a stateless CLI in any CI, or locally in your terminal without touching a PR.

What ships:

- GitHub and Bitbucket Cloud adapters plus a local mode; idempotent PR comments, native suggestion blocks, commit statuses, JSON reports, and a hard `--dry-run` guarantee
- Anthropic, Bedrock, OpenRouter and any OpenAI-compatible host (including local models) as review models
- guidelines read from the merge target by default, so a PR cannot weaken the rules that judge it; language and path scoping; `guidelines lint`
- cross-file context strategies (a zero-cost repo map by default, on-demand agentic tools, experimental retrieval)
- multi-model ensemble review with union or judge merging
- an in-process cost guard with per-review and monthly caps
- secret and PII redaction before anything reaches a model
- `init`, `doctor` and a benchmark harness (`bench`) with seed cases

Start with the [getting started guide](docs/guides/getting-started.md) and the [CI recipes](docs/guides/ci-recipes.md).

## Development

```bash
pnpm install
pnpm test          # unit tests
pnpm test:coverage # with coverage gate
pnpm build         # bundle the CLI to dist/
node dist/cli.js --version
```

Commits follow the conventional commit format, enforced by a commit hook. The changelog and versioning are generated from them.

The domain vocabulary lives in CONTEXT.md; design decisions live in the ADR registry; product and technical docs sit behind the PRD and spec registries.

## License

Apache-2.0
