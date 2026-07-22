# Guideline packs

A pack is a shareable guideline set: a directory holding a `pack.yaml` manifest and guideline markdown files in the same format as `guidelines/`. Packs let several repositories consume one maintained rule set while keeping their own local guidelines on top.

## Anatomy

```
sfcc-pack/
  pack.yaml
  no-dw-logger.md
  jobs/no-busy-wait.md
```

`pack.yaml` needs a `name`; `version` and `description` are optional:

```yaml
name: sfcc
version: 1.0.0
description: SFCC platform guidelines
```

## Consuming packs

List packs under `review.packs` (or `DELTA_PEACOCK_REVIEW_PACKS`, comma-separated). Each entry is either a directory resolved against the repo root, or a pinned git URL:

```yaml
review:
  packs:
    - vendor/sfcc-pack # a directory checked into the repo
    - node_modules/@acme/sfcc-pack # an npm-installed pack
    - https://github.com/acme/sfcc-pack.git#v1.2.0 # a pinned git URL
```

A spec counts as a git URL when it starts with `http://`, `https://` or `git://`, or ends in `.git`; an optional `#ref` pins a tag, branch or commit. Git packs are fetched shallowly at the pinned ref into `.delta-peacock-cache/packs/` and reused from there on later runs, so add that directory to `.gitignore`. To pick up a moved branch ref, delete the cache directory. npm distribution needs no special support: install the package and point `review.packs` at its `node_modules` path.

## Precedence

Packs load first, in listed order; the local corpus loads last. On an id collision a later pack beats an earlier one, and a local guideline always beats every pack. Each override prints a notice naming the guideline and the pack that lost, so a pack can never displace a rule silently.

Findings that cite a pack guideline carry the pack name in the review report (`pack` on the finding), so provenance survives into artifacts and tooling.

## Authoring a pack

Wrap an existing guidelines directory:

```
npx delta-peacock guidelines pack init --name sfcc
```

This writes `packs/sfcc/pack.yaml` and copies the markdown files from `guidelines/` (override with `--dir`); `--out` picks a different destination and `--force` overwrites one that exists. Publish the resulting directory as a git repository or an npm package.

## Migrating a legacy corpus

Guideline sets written for the predecessor format (singular `language`, a `name` field instead of an H1 title) convert in one step:

```
npx delta-peacock guidelines import --from legacy-guidelines --out guidelines
```

`language: python` becomes `languages: [python]`, and `name` is dropped into the H1 title when the body lacks one. Everything else is preserved, so re-running the command changes nothing. Without `--out` the conversion happens in place. `pack init` on an imported corpus produces a loadable pack.
