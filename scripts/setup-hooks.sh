#!/usr/bin/env sh
# Points git at the committed hooks once per clone; with husky, husky keeps the path and calls .githooks.
set -e
cd "$(git rev-parse --show-toplevel)"
for file in .githooks/commit-msg .githooks/pre-push scripts/setup-hooks.sh scripts/stale-branches.sh scripts/github-settings.sh; do
  [ -f "$file" ] && chmod +x "$file"
done
git config --get baseline.dashes >/dev/null || git config baseline.dashes forbid
if [ -d .husky ]; then
  echo 'setup-hooks: husky owns core.hooksPath; its hooks call .githooks'
  exit 0
fi
git config core.hooksPath .githooks
echo 'setup-hooks: core.hooksPath is .githooks'
