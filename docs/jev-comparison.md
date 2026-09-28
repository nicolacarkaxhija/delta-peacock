# Jev judge against the Haiku judge

Run on 2026-09-28 from `feat/jev-judge`, consumer config (Haiku 4.5 on Bedrock, `full_files` plus `agentic`, five checks bound), `judge.minConfidence` 0.7, Jev model `jev-latest` (answered as `jev-1.13.0`).

## Where the judge runs

The judge only settles check candidates that need a reading: CSS near a comment without a reason, possible narration. In the 19 backtest cases that is two cases, pr09 (`pages/pdp.ts:16`) and pr44 (`pages/account.ts:97`); the other 17 cases never call a judge, so their result cannot depend on the provider. The Haiku arm ran all 19 cases three times; the Jev arm ran the two judged cases, pr09 three times and pr44 once.

## Backtest

| count                         | Haiku judge                            | Jev judge                                                             |
| ----------------------------- | -------------------------------------- | --------------------------------------------------------------------- |
| wrong                         | 0                                      | 0                                                                     |
| missed                        | 0                                      | 3: pr09 `pages/pdp.ts:16` in 3 of 3 repeats                           |
| drift                         | 0                                      | 0                                                                     |
| judge latency per call        | 1,219 ms mean (925 to 2,040, 6 calls)  | 584 ms median (302, 405, 762, 8,258; the slow one was the first call) |
| review wall time, pr09 / pr44 | 19 s / 29 s                            | 18 to 31 s / 33 s                                                     |
| cost per review, pr09 / pr44  | 0.0802 / 0.2512 USD                    | 0.0792 / 0.2519 USD                                                   |
| judge cost per call           | about 0.001 USD inside the review cost | 0.000046 USD (about 1,100 input tokens)                               |

The Jev misses: the candidate on pr09 is a real finding (the Haiku judge confirms it every time), and Jev answered with confidence 0.00, 0.13 and 0.04, so `judge.minConfidence` dropped it each time. On pr44 Jev confirmed the finding at 0.84.

Haiku arm over all 19 cases: precision 100%, recall 100% worst of three, drift 0, 3.33 USD for 57 reviews (0.058 USD per review).

## Bench, 23 cases, one run each

| arm         | precision | recall | F1  | judge calls | mean case time | cost      |
| ----------- | --------- | ------ | --- | ----------- | -------------- | --------- |
| Haiku judge | 100       | 100    | 100 | 0           | 5,298 ms       | 0.265 USD |
| Jev judge   | 100       | 100    | 100 | 0           | 5,747 ms       | 0.265 USD |

Checks bound: selectors, assertions, tags, timeouts. The comments check stays unbound because the bench's `natural-comments` guideline lacks the sentence it quotes. Every bench candidate is a measured fact, so neither arm calls a judge and the bench cannot tell the providers apart.

## Decision

The default stays `judge.provider: model`. Jev is faster and far cheaper per call, but it missed a real finding in every repeat, and a switch needs Jev at least as good on every count.

## Confidence floor

Measured on 2026-09-29 on a local merge of this branch with `fix/checks-decide-facts` (the numbers check), so the judge saw the candidates it will see after both merge. Every judged check candidate of the 13 self cases, the 20 consumer cases and the judge case `numbers-reasons` went to `jev-latest` (answered as `jev-1.13.0`) once, at floor 0, and each answer's choice and confidence were recorded; each floor was then applied to the recorded answers, no further call. A candidate is real when the case lists it as a finding; the other 23 are 10 the cases list as no finding and 13 the cases leave unlisted, which the Haiku judge drops in every green backtest run.

| floor | real findings kept (of 26) | wrong findings passed (of 23) | of them listed (of 10) |
| ----- | -------------------------- | ----------------------------- | ---------------------- |
| 0.50  | 23                         | 13                            | 3                      |
| 0.55  | 22                         | 10                            | 1                      |
| 0.60  | 22                         | 9                             | 1                      |
| 0.65  | 22                         | 9                             | 1                      |
| 0.70  | 21                         | 8                             | 1                      |
| 0.75  | 21                         | 8                             | 1                      |
| 0.80  | 21                         | 8                             | 1                      |
| 0.85  | 20                         | 6                             | 0                      |
| 0.90  | 17                         | 4                             | 0                      |

The default is 0.6: 0.60 and 0.65 give the best F1 over all 49 (0.77) and the best net count over the 36 listed ones (22 kept, 1 passed). The sample is small: 49 candidates from 11 cases, one answer each, so one candidate moves a floor's count; tune `judge.minConfidence` per repository. No floor fixes the passes: Jev keeps 7 unlisted CSS candidates of the consumer's pr73 and pr06 at 0.66 to 0.94, and keeps the real pr09 candidate at only 0.03, so every floor drops it. The floor also gates Jev calibration, which this sample did not measure. Jev spend: 62,354 input tokens, 0.0026 USD.

## Notes

- `DELTA_PEACOCK_JUDGE_PROVIDER` does not reach backtest replays, which read the `--config` file only; the Jev arm needs `judge.provider: jev` in that file.
- Jev spend: about 4,800 input tokens in total (one probe of 356 tokens and four judge calls), about 0.0002 USD.
