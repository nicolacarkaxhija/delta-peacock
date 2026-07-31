# delta-peacock

Guideline-anchored, provider-agnostic PR reviewer: reviews pull requests against the markdown
guidelines a team keeps in its own repo. Findings cite a guideline and inherit its severity;
the gate is a deterministic exit code. Ships as a stateless Node CLI (`delta-peacock`, built
to `dist/` with tsup) — no server, no telemetry. Public repo (Apache-2.0) on GitHub.

## Run

```
pnpm install
pnpm build            # tsup -> dist/cli.js
node dist/cli.js --help
```

## Test

```
pnpm test             # vitest
pnpm test:coverage
pnpm lint && pnpm typecheck && pnpm docs:check
```

## Conventions

- Conventional Commits (commitlint via husky); release-please manages releases; effort
  trailer (`Effort: ~1h`) on every commit.
- Config schema snapshot: refresh with `pnpm schema:update` after config-shape changes.

## Gotchas

- `engines` is `>=20` deliberately (consumer floor); local dev pin is Node 24 (.nvmrc),
  pnpm 11 via corepack.
- LLM calls go through the AI SDK (anthropic, openai, bedrock) — provider credentials are
  needed at runtime, via env (`.env*` is gitignored).
- `.delta-peacock-cache/` is local run state, never committed.
