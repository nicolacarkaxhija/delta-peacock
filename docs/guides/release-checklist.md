# Release checklist

Releases are cut by release-please from conventional commits; the human part is verification.

1. Confirm CI is green on main, including the docs integrity job.
2. Dispatch the `live-smoke` workflow once per provider you claim support for (at minimum anthropic). It runs one tiny real review round-trip under a fixed cost ceiling.
3. Run the benchmark over the seed cases with your release configuration and compare against the previous release's numbers: `delta-peacock bench --cases bench/cases --context repo_map`.
4. Merge the release-please PR. The tag triggers the GHCR image build automatically; npm publishing additionally requires the `NPM_PUBLISH` repository variable set to `true` (kept off until the public flip).
5. Skim the generated changelog for anything that reads wrong; fix forward with a docs commit rather than editing the release.
