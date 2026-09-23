#!/usr/bin/env sh
# Squash merges only, the pull request title as the subject, head branches deleted on merge.
set -e
repo=${1:?usage: github-settings.sh <owner/repo>}
gh repo edit "$repo" --enable-squash-merge --enable-merge-commit=false --enable-rebase-merge=false --delete-branch-on-merge
gh api -X PATCH "repos/$repo" -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=BLANK >/dev/null
echo "github-settings: $repo merges by squash with the title as the subject and deletes the branch"
