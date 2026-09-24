# Release checklist

Releases are cut by release-please from conventional commits; the human part is verification.

1. Confirm CI is green on main, including the docs integrity job, and that `pnpm test:coverage` holds the 95% gate.
2. Run the benchmark over the cases with the reference configuration (Bedrock Haiku 4.5, agentic context) and compare against the previous release's numbers: `DELTA_PEACOCK_MODEL_PROVIDER=bedrock DELTA_PEACOCK_MODEL_ID=eu.anthropic.claude-haiku-4-5-20251001-v1:0 delta-peacock bench --cases bench/cases --context agentic`. Repeat for any other provider you claim support for.
3. Build the tarball with `pnpm pack:bundled` and install it with `npm install --ignore-scripts --no-save ./delta-peacock-<version>.tgz` in an empty directory with the network off; `delta-peacock --version` must answer.
4. Merge the release-please PR. The tag triggers the GHCR image build automatically; npm publishing additionally requires the `NPM_PUBLISH` repository variable set to `true` (kept off until the public flip).
5. Skim the generated changelog for anything that reads wrong; fix forward with a docs commit rather than editing the release.
