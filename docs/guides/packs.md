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

Before you publish, validate it:

```
npx delta-peacock guidelines pack lint --dir packs/sfcc
```

`pack lint` checks the manifest (a name is required; a missing version or description is a warning, since the registry and pinned consumers rely on them) and runs the full guideline validation over every rule in the pack, including the token-budget and machine-checkable warnings. It exits non-zero on any problem, so it belongs in the pack repository's own CI.

## Available packs

The repository ships curated starter packs under [`packs/`](../../packs). Seed a new corpus from one with `init --starter`, or list them in `review.packs`:

| Pack                                   | What it covers                                                                                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`security`](../../packs/security)     | Hard-coded secrets, dynamic-code execution, input validation, query parameterization.                                                                             |
| [`typescript`](../../packs/typescript) | Escaping the type system, exhaustive union switches, floating promises, named numbers, natural comments, swallowed errors, unused exports.                        |
| [`playwright`](../../packs/playwright) | Web first assertions, locators in page objects, explained CSS selectors, no inline waits, one behavior per test, known failures, skips, data rows, declared tags. |
| [`commits`](../../packs/commits)       | Conventional subjects, one behavior per change, change texts that match the diff.                                                                                 |

These are a floor, not a policy: fork one, cut what does not fit, and keep the rest under your own id namespace. Community packs are welcome by pull request; add a row here and make sure `pack lint` passes.

### Adding a shipped pack to a reviewed repository

The packs ship inside the npm package, so a reviewed repository that installs the reviewer lists them by their `node_modules` path. A repository that runs the reviewer without installing it copies the pack folder into the repository and lists that path:

```yaml
review:
  guidelinesDir: guidelines
  packs:
    - node_modules/delta-peacock/packs/playwright
    - node_modules/delta-peacock/packs/typescript
```

`review.packs` is the only key a pack needs. The reviewed repository keeps its own guidelines in `review.guidelinesDir`, and they win: a local guideline with the same id as a pack rule replaces it, and the review prints which pack rule it replaced. To change one sentence of a pack rule, copy the file into the guidelines folder under the same id and edit it there.

### Rules a check owns and rules the model judges

Every pack rule is one of two kinds. A rule that says every sentence of a static check word for word is owned by that check without a binding: its findings are measured facts, so they are found with no model at all (see [Static checks](checks.md)). The rule quotes the check's sentence and the check quotes the rule, so the two agree by construction. Every other rule carries `tags: [judged]` in its frontmatter: only the model can review it, and with `model.provider: none` it is named under `factsOnly.notReviewed`.

| Pack         | Rules a check owns                                                                                               | Rules the model judges                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `playwright` | `web-first-assertions`, `explained-css-selectors`, `no-inline-timeouts`, `data-rows-not-copies`, `declared-tags` | `locators-in-page-objects`, `one-behavior-per-test`, `known-failures-carry-a-ticket`, `no-skip-on-page-answer`    |
| `typescript` | `no-magic-numbers`, `natural-comments`                                                                           | `errors-never-swallowed`, `no-unused-exports`, `no-any-escape-hatch`, `exhaustive-switch`, `no-floating-promises` |
| `commits`    | none                                                                                                             | `conventional-subjects`, `one-behavior-per-change`, `text-matches-diff`                                           |
| `security`   | none                                                                                                             | all four                                                                                                          |

A test keeps the two in step: every sentence a check quotes is said by a shipped pack rule, every check owns one, and every other pack rule is marked as judged. A check sentence that changes without its pack rule fails that test.

### Pack rules on the bench

Each new pack rule has a bench case under [bench/cases](../../bench/cases): a small invented repository in `files/`, a change in `diff.patch` that breaks the rule once, and a `packs.json` naming the pack the case is reviewed with, relative to the case directory. A case that also holds a `guidelines/` folder reviews with both, the case's own guidelines winning as in a review. With no model the bench scores the rules a check owns and counts the others under `judgement`:

```
npx delta-peacock bench --cases bench/cases --provider none
```

## Migrating a legacy corpus

Guideline sets written for the predecessor format (singular `language`, a `name` field instead of an H1 title) convert in one step:

```
npx delta-peacock guidelines import --from legacy-guidelines --out guidelines
```

`language: python` becomes `languages: [python]`, and `name` is dropped into the H1 title when the body lacks one. Everything else is preserved, so re-running the command changes nothing. Without `--out` the conversion happens in place. `pack init` on an imported corpus produces a loadable pack.
