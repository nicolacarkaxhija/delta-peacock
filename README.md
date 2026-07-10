# delta-peacock

Guideline-anchored, provider-agnostic PR reviewer. Your rules, any SCM, any LLM.

**Status: early development.** Nothing is released yet. The full product spec and the work breakdown live in the [issue tracker](https://github.com/nicolacarkaxhija/delta-peacock/issues).

## What it does

delta-peacock reviews pull requests against your team's own guidelines: markdown files with a small frontmatter header, versioned inside the repository being reviewed. Every finding cites the guideline it violates and inherits that guideline's severity, so the model cannot invent importance. It runs as a stateless CLI in any CI, or locally in your terminal without touching a PR.

The v1 plan, in short:

- Bitbucket Cloud and GitHub adapters, plus a local mode that never touches a PR
- Anthropic, Bedrock, OpenRouter and OpenAI-compatible model providers
- idempotent PR comments, commit statuses and JSON reports
- selectable cross-file context strategies and multi-model ensemble review
- an in-process cost guard and a benchmark harness

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
