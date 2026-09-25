#!/bin/sh
# Packs a self-contained tarball: runtime dependencies bundled at their lockfile versions,
# so it installs offline with --ignore-scripts. Usage: pack-bundled.sh [destination-dir]
set -eu
root=$(pwd)
dest=$(cd "${1:-.}" && pwd)
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
pnpm build
cp -r dist schema packs CHANGELOG.md README.md LICENSE package.json pnpm-lock.yaml pnpm-workspace.yaml "$stage"/
cd "$stage"
# real copies: hard links from the store pack as tar link entries that break on extract
pnpm install --prod --frozen-lockfile --ignore-scripts --config.node-linker=hoisted \
  --config.package-import-method=copy
rm -f pnpm-lock.yaml pnpm-workspace.yaml
# drop what no runtime loads (types, TS sources, docs, maps); npm unpacks per file, twice
find node_modules -type f \( -name '*.ts' -o -name '*.cts' -o -name '*.mts' -o -name '*.map' \
  -o -name '*.md' -o -name '*.mdx' -o -name '*.markdown' \) \
  ! -iname 'licen[cs]e*' ! -iname 'notice*' -delete
find node_modules -type d -empty -delete
npm pack --ignore-scripts --pack-destination "$dest"
cd "$root"
