# Release

release-please cuts the releases here: every `feat` and `fix` subject on `main` lands in its
release pull request, and merging that pull request tags the version, writes `CHANGELOG.md` and
creates the GitHub release. The human part is the checks around it.

1. Clean checkout: a fresh clone of `main`, never the working copy you develop in.

   ```sh
   git clone https://github.com/nicolacarkaxhija/delta-peacock.git /tmp/release-dp && cd /tmp/release-dp
   pnpm install --frozen-lockfile
   ```

2. Checks: every line of [acceptance.md](acceptance.md) green, including the release lines (build,
   offline tarball, bench). Record the commit and the numbers; a red line stops the release.
3. Merge the release-please pull request with its own title, `chore(release): <version>`.
4. Check what the tag published and skim the changelog; fix forward with a `docs` commit, never by
   editing the release. The full list is [release-checklist.md](guides/release-checklist.md).

While GitHub Actions are off on the owner's account, release-please does not run: the release
commit `chore(release): <version>` with the version bump and the changelog section is made by hand
through a pull request, then tagged `v<version>` on `main`.

Never move or delete a pushed tag and never force push `main`; a bad release is fixed by the next
one.
