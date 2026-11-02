# Backtest on real pull requests

`bench` scores the reviewer on small synthetic cases. `backtest` replays your own pull requests
through the real `review` command and holds every finding to what a careful person decided about
it. A release that finds something new that a person judged wrong, drifts between runs, or finds
less than the last passing run fails the backtest.

```
delta-peacock backtest --cases <dir> [--repeats 3] [--config <file>] [--only a,b] [--concurrency 3] [--report out.json] [--provider none] [--anchor-window 0] [--intake <dir>]
```

`--provider` runs every case under that model provider. With `none` the run checks facts only and
makes no model call: every expected finding a fact decides must be found and none may be wrong,
while the ones that need a judgement are counted in their own column and listed, never failed. The
baseline is neither read nor written; see
[facts only](checks.md#facts-only-with-no-model).

Exit 0 means the run passed and the baseline moved to it; 2 means it failed (every reason is
printed); 1 is a tool error.

## A case

One folder per reviewed pull request revision:

- `base/`: the target branch as the review saw it, guidelines and `delta-peacock.config.yaml`
  included. Leave out large binaries the diff does not touch.
- `diff.patch`: the pull request, `git diff --binary <merge-base> <head>`.
- `expected.json`: the human judgement.
- `case.json` (optional): where it came from; the harness does not read it.

```json
{
  "findings": [
    {
      "file": "pages/plp.ts",
      "line": 16,
      "endLine": 17,
      "guidelineId": "prefer-test-ids",
      "severity": "MINOR",
      "mustMention": ["getByTestId"],
      "mustNotSuggest": ["toHaveAttribute"],
      "why": "the test id wrapped in CSS, with no comment saying why"
    }
  ],
  "noFinding": [
    {
      "file": "tests/smoke/footer.spec.ts",
      "line": 3,
      "guidelineId": "axis-tags",
      "why": "no declared feature covers the footer"
    }
  ]
}
```

A finding is right when it sits on an expected span (`line` to `endLine`), cites the same
guideline, has the expected severity, mentions every `mustMention` text and suggests none of the
`mustNotSuggest` texts. Every other finding is wrong and is named with its reason; one on a
`noFinding` span says it was judged wrong before. An expected finding nobody produced is missed.

A person comments on the line they read, which is not always the line the code breaks: the call
one line below, the opening of the block above. `--anchor-window <lines>` widens every expected
span by that many lines either way, so a finding on such a nearby line counts as right. A
finding inside the window of two spans goes to the nearest one. The window is 0 by default, it
never widens a `noFinding` span, and the run's `summary.json` records it as `anchorWindow`.

## False positives from the editor

A review run with `--findings` leaves a record of the change it saw, and each finding in the
findings file names that record as its evidence (see
[findings for the editor](../../README.md#findings-for-the-editor)). When a person marks one of
those findings as a false positive, the test engine writes a backtest case file into the reviewed
repository's `findings/backtest/` folder, holding the fingerprint, the reason and the finding.

```
delta-peacock backtest --cases <cases> --intake findings/backtest [--only false-positive-<fingerprint>]
```

Run it from the clone the review ran in. Before the cases load, every file in the intake folder
whose finding the reviewer produced becomes the case `false-positive-<fingerprint>`: `base/` is the
tree of the commit the record names, `diff.patch` is the recorded change, and `expected.json`
holds the finding's span as a `noFinding` entry with the person's reason as its `why`, and
`othersUnjudged: true`.
`case.json` names the file it came from. A file is skipped, with its reason on one line, when the
case already exists, another producer wrote the finding, the file is not a false positive file, the
finding names no record, a record outside `.delta-peacock-cache/reviews/` or one that is gone, or
the record's commit is not in the clone.

`othersUnjudged: true` in any case's `expected.json` judges only its listed spans: a finding on no
`findings` or `noFinding` span is left unjudged. It is not wrong, it is not counted in `found` or
precision, and it does not count as drift, so a case made from one false positive fails only when
the marked finding comes back.

## What a run does

For every case and repeat it commits `base/` on `main`, applies `diff.patch` on a branch above it,
puts the `--config` file on `main` when one is given, and runs `review` there with local SCM, dry
run and the response cache off, so nothing is posted and no repeat reuses another's answer.

It fails when any finding is wrong, when a finding appears in some repeats and not others
(drift), when a review threw, when a finished review did not print its `full_files context`,
`cost` or `stats` line while the config asks for them, or when recall falls under the baseline
(for the whole run, and per case).

The table shows per case: the findings expected, then found, right, wrong and missed per repeat,
the findings the review dropped off the change per repeat (see
[findings on changed lines](checks.md#findings-on-changed-lines)), the drift, the mean time and
the cost of all repeats. The total line and `summary.json` carry the same count as `offChange`. Logs and reports of every review land in
`<cases>/runs/<timestamp>/`, with each refused candidate in the log for tracing a miss.

## The baseline

A passing full run writes `<cases>/baseline.json`: the reviewer version, the aggregate recall of
its worst repeat, precision, and each case's recall. The next run must reach both. A run with
`--only` compares its cases but leaves the baseline as it was.

## Keeping cases out of this repository

Cases hold a team's code. Keep them next to the team's own review notes, not here.

[bench/backtest](../../bench/backtest) holds the exception: synthetic cases, written fresh, each
rebuilding the shape of a finding a person judged wrong on a real pull request, with no line of
that pull request in it. Each one runs one model call per review, so a release can run them all:
`delta-peacock backtest --cases bench/backtest`.
