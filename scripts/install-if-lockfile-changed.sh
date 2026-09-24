#!/bin/sh
# Runs pnpm install only when pnpm-lock.yaml differs between two commits.
# Usage: install-if-lockfile-changed.sh <from> <to>
[ -n "$1" ] && [ -n "$2" ] || exit 0
git diff --quiet "$1" "$2" -- pnpm-lock.yaml 2>/dev/null
[ $? -eq 1 ] || exit 0
echo "pnpm-lock.yaml changed, running pnpm install"
pnpm install
