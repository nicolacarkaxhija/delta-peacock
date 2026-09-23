#!/usr/bin/env sh
# Lists the remote branches with no commit for more than N days, oldest first.
# The stale age docs/contributing.md sets.
stale_days=14
days=${1:-$stale_days}
seconds_per_day=86400
git fetch -q --prune origin || exit 1
cutoff=$(($(date +%s) - days * seconds_per_day))
git for-each-ref --sort=committerdate \
  --format='%(committerdate:unix) %(committerdate:short) %(refname:short) %(authorname)' refs/remotes/origin |
  while read -r stamp day ref author; do
    case "$ref" in origin | origin/HEAD | origin/main) continue ;; esac
    [ "$stamp" -lt "$cutoff" ] && echo "$day $ref $author"
  done
exit 0
