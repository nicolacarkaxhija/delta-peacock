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

## Notes

- `DELTA_PEACOCK_JUDGE_PROVIDER` does not reach backtest replays, which read the `--config` file only; the Jev arm needs `judge.provider: jev` in that file.
- Jev spend: about 4,800 input tokens in total (one probe of 356 tokens and four judge calls), about 0.0002 USD.
