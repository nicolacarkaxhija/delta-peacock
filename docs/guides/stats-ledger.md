# The stats ledger

With `stats.enabled: true` every review appends to `delta-peacock.stats.jsonl` (or `stats.path`): one review line, then one line per finding that survived to the gate. Baselined and waived findings are not recorded. `delta-peacock stats` folds the review lines into a per-contributor view; anything else reading the file (a metrics job, `jq`) can group the finding lines by pull request, scope or guideline.

## Review line

| Field         | Meaning                                                                                 |
| ------------- | --------------------------------------------------------------------------------------- |
| `kind`        | `"review"`                                                                              |
| `at`          | ISO timestamp of the run                                                                |
| `author`      | Commit author of the reviewed head                                                      |
| `addedLines`  | Lines the change adds                                                                   |
| `bySeverity`  | Finding counts per severity                                                             |
| `byGuideline` | Finding counts per guideline id; observations count under `(observation)`               |
| `errors`      | `{ "misquoted": n }` when the reviewer invented rules; absent otherwise                 |
| `pr`          | `{ "number", "url" }`, each part only when the SCM provides it; absent in local runs    |
| `title`       | The pull request title, when the SCM provides it                                        |
| `scope`       | Parsed from a conventional title `type(scope): ...`; empty when the title has none      |
| `type`        | The conventional type (`feat`, `fix`, ...), lower case; empty when the title is not one |
| `model`       | The review model id in use, `DELTA_PEACOCK_MODEL_ID` included                           |
| `tokens`      | `{ "input", "output", "cacheRead", "cacheWrite" }` summed over every call of the review |
| `cost`        | USD, priced with the model's rates; absent when the model has none                      |
| `durationMs`  | Wall time of the review                                                                 |

## Finding line

`kind` is `"finding"`; `at`, `author`, `pr`, `title`, `scope` and `type` repeat the review's values, so each line stands alone. Then `guideline` (the cited id, or `(observation)`), `severity`, `file` and `line`.

## Example

```jsonl
{"kind":"review","at":"2026-09-26T10:00:00.000Z","author":"Ada","addedLines":12,"bySeverity":{"MAJOR":1},"byGuideline":{"no-console":1},"pr":{"number":7,"url":"https://github.com/acme/widgets/pull/7"},"title":"feat(checkout): gift cards","scope":"checkout","type":"feat","model":"claude-sonnet-4-5","tokens":{"input":1000,"output":100,"cacheRead":0,"cacheWrite":0},"cost":0.0015,"durationMs":8421}
{"kind":"finding","at":"2026-09-26T10:00:00.000Z","author":"Ada","pr":{"number":7,"url":"https://github.com/acme/widgets/pull/7"},"title":"feat(checkout): gift cards","scope":"checkout","type":"feat","guideline":"no-console","severity":"MAJOR","file":"src/app.js","line":3}
```

## Older ledgers

Every field added here is optional. Review lines written before them carry no `kind`, `pr`, `title`, `scope`, `type`, `model`, `tokens`, `cost` or `durationMs`, and there are no finding lines for those reviews; `delta-peacock stats` reads both alike. A reader should treat a missing `kind` as `"review"`.

## Pricing per model

`cost.rates` maps a model id to its own rates; the entry for the model in use wins, and the flat `cost.rate*Per1M` keys price any model without an entry. An override through `DELTA_PEACOCK_MODEL_ID` is therefore priced at the overriding model's rates, and the log's cost line names the model: `cost: 1000 tokens in, 100 out on claude-sonnet-4-5, 0.0015 USD; ...`.

```yaml
cost:
  rateInputPer1M: 3
  rateOutputPer1M: 15
  rates:
    claude-haiku-4-5:
      rateInputPer1M: 1
      rateOutputPer1M: 5
```

A field missing from an entry is unpriced (zero); it never falls back to the flat key, which may belong to another model. `DELTA_PEACOCK_COST_RATES` takes the map as JSON.
