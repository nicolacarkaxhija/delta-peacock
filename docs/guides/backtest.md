# Backtest on real pull requests

`bench` scores the reviewer on small synthetic cases. `backtest` replays your own pull requests
through the real `review` command and holds every finding to what a careful person decided about
it. A release that finds something new that a person judged wrong, drifts between runs, or finds
less than the last passing run fails the backtest.

```
delta-peacock backtest --cases <dir> [--repeats 3] [--config <file>] [--only a,b] [--concurrency 3] [--report out.json]
```

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

## What a run does

For every case and repeat it commits `base/` on `main`, applies `diff.patch` on a branch above it,
puts the `--config` file on `main` when one is given, and runs `review` there with local SCM, dry
run and the response cache off, so nothing is posted and no repeat reuses another's answer.

It fails when any finding is wrong, when a finding appears in some repeats and not others
(drift), when a review threw, when a finished review did not print its `full_files context`,
`cost` or `stats` line while the config asks for them, or when recall falls under the baseline
(for the whole run, and per case).

The table shows per case: the findings expected, then found, right, wrong and missed per repeat,
the drift, the mean time and the cost of all repeats. Logs and reports of every review land in
`<cases>/runs/<timestamp>/`, with each refused candidate in the log for tracing a miss.

## The baseline

A passing full run writes `<cases>/baseline.json`: the reviewer version, the aggregate recall of
its worst repeat, precision, and each case's recall. The next run must reach both. A run with
`--only` compares its cases but leaves the baseline as it was.

## Keeping cases out of this repository

Cases hold a team's code. Keep them next to the team's own review notes, not here.
