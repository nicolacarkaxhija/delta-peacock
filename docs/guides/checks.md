# Static checks for mechanical guidelines

Some guidelines are mechanical: a CSS selector without a reason comment, a comment that spans two
lines, a snapshot read inside `expect`, a tag the suite does not declare, an inline wait. A model asked to find
those in a whole diff misses some and invents others from run to run. Bind such a guideline to a
static check and the check finds the lines; nothing else can become a finding under it.

```yaml
review:
  checks:
    prefer-test-ids: selectors
    natural-comments: comments
    web-first-assertions: assertions
    axis-tags: tags
    no-inline-timeouts: timeouts
    no-magic-numbers: numbers
    data-rows-not-copies: rows
```

The key is the guideline id, the value one of the checks below. Every check looks only at
added lines, in files the guideline's own `paths` and `languages` cover. The open review still
reads the whole corpus, so its prompt does not change; a finding it reports under a checked
guideline is dropped and logged as `checked`.

A guideline that says every sentence of a check word for word (the table at the end) is checked
by it without a binding: what the check measures is a fact, so an open review must not claim a
dash the comment does not hold or miss a comment that spans lines. A binding under
`review.checks` still wins for its guideline.

## The checks

| Check        | A candidate is                                                                                                                                                                                                                                                                                                  | The fix it names                                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `selectors`  | a `.locator(...)` whose selector is CSS, a plain test id wrapped in CSS, a test id prefix (`[data-testid^="..."]`), test ids joined into a CSS list, a derived hook (a helper call with a `suffix`) or any other attribute selector such as `[data-ref="${title}"]`, string or template, with no reason comment | `getByTestId('id')` for a test id, a `getByTestId` regex for a prefix or a list, `or()` for a list, a reason comment or `getByRole` for other CSS   |
| `comments`   | a comment on a changed line that spans lines (a doc comment opening with `/**` may), uses a dash as punctuation on any of its changed lines, or tells the story of the change                                                                                                                                   | the comment folded into one line, the dash turned into a comma                                                                                      |
| `assertions` | a snapshot read inside `expect` or passed to its matcher: `isVisible()`, `textContent()`, `count()`, `url()`, `cookies()`, `evaluate()` and the rest, a page object method whose body makes one, or an awaited page object method whose body reads the browser                                                  | the web first matcher for what was read: `toHaveURL`, `toBeVisible`, `toHaveText`, `toHaveCount`, and so on; `expect.poll` for any other page state |
| `tags`       | a tag in the tag option that `review.repoConfigPath` does not declare, or a tag in the test title                                                                                                                                                                                                               | the tag list without it, or the tag moved into the option                                                                                           |
| `timeouts`   | `waitForTimeout(...)`, a sleep helper (`sleep`, `delay`, `pause`, `wait`) or `setTimeout` with a literal number, and a `timeout`, `delay` or `intervals` option holding a literal number or a local numeric constant; zero is no wait                                                                           | a named value in the repository's `timeouts` file passed in its place, or a web first wait on the state the sleep stands in for                     |
| `numbers`    | a number written inline, a regex quantifier and a shell default included, or a named numeric constant, in TypeScript, JavaScript or shell; zero, one, unit factors (`* 1000`), list indexes and names that state a conversion (`MS_PER_SECOND`) are no candidates                                               | a named constant declared once, next to a comment with the reason for its value                                                                     |
| `rows`       | a test call that repeats another test, in the same file or another file the guideline covers, with only its literals changed; one test body looped over rows is one call                                                                                                                                        | one scenario with data rows: one test body in a loop over the rows                                                                                  |

A reason comment counts on the line, the line above, above the statement, heading a group of
declarations (single line ones, or a run of multi-line ones with no blank line between), in the
doc comment of the enclosing function, or on the declaration of a constant the selector uses. It
counts when it names the locator vocabulary (test id, role, class, attribute, shadow root) or
gives a because. A helper call with a `suffix` builds a derived hook attribute that `getByTestId`
cannot read; it is still CSS, so it needs the same comment.

## A pattern the guideline declares

A guideline whose rule a regular expression can state declares the check in its own frontmatter,
under `check:`, and needs no binding under `review.checks`. Every finding is a measured fact: no
model, no judge and no drift, so it counts as decided by facts in the backtest and in the facts
only mode.

```markdown
---
id: logger-category
severity: MAJOR
paths: ["cartridges/**"]
check:
  type: pattern
  files: ["cartridges/**/*.js"]
  added: "getLogger\\(\\s*['\"][^'\"]+['\"]\\s*\\)"
  unless: "getLogger\\([^,]+,\\s*['\"]"
  message: "getLogger takes a category as its second argument"
---

# Loggers name their category

getLogger takes a category as its second argument, so the log lines of one area can be filtered.
```

| Key          | Meaning                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------ |
| `type`       | `pattern`, the one type a guideline declares itself                                                          |
| `files`      | path globs on top of the guideline's own `paths` and `languages`; left out, every file the guideline covers  |
| `added`      | a regex no added line may match; every match is a finding on that line                                       |
| `unless`     | a regex whose match on the same line excuses an `added` match                                                |
| `absent`     | a regex a changed file must match somewhere; a file that never does is one finding on its first added line   |
| `scope`      | `line` for `added`, `file` for `absent`; left out, it follows the key                                        |
| `maxPerFile` | at most this many findings in one file; the last one says how many more lines match                          |
| `message`    | the guideline sentence every finding quotes and the finding's title; the guideline must say it word for word |

A guideline declares exactly one of `added` and `absent`. The pattern reads every file type, so
templates, XML and properties files can carry one. A finding has the guideline's severity and
quotes its `message` as the `Guideline: ...` line, exactly like the checks above.

Two more rules a pattern decides. Rhino era constructs:

```yaml
check:
  type: pattern
  files: ["cartridges/**/*.js"]
  added: '\b(?:importPackage|importClass)\s*\('
  message: "Scripts load modules with require, never with importPackage or importClass."
```

Writes to `session.custom` outside an allowlist of keys:

```yaml
check:
  type: pattern
  files: ["cartridges/**/*.js"]
  added: 'session\.custom\.\w+\s*=[^=]'
  unless: 'session\.custom\.(?:basketToken|lastSearch)\s*='
  message: "Only basketToken and lastSearch live in session.custom."
```

And a file rule with `absent`:

```yaml
check:
  type: pattern
  files: ["cartridges/**/*.js"]
  absent: '^\s*[''"]use strict[''"];'
  scope: file
  message: "Every script opens with the use strict directive."
```

Each regex is compiled once, when the guidelines load. `guidelines lint` fails on an invalid
regex, naming the guideline and the error (`guideline "logger-category" check: "added" is not a
valid regex: ...`), and on an unknown key, a missing `message` or a `message` the guideline does
not say; a review skips such a guideline with the same words. A binding under `review.checks`
still wins over a declared pattern.

## Facts and the judge

Most candidates are measured facts and become findings without a model call. Some turn on
prose: a CSS selector near a comment that names no reason, a comment that may narrate the change,
and a number that may or may not be a timeout, delay, retry count, limit or threshold. For those
the judge answers one question per candidate.

- For a number it also names the kind: timeout, delay, retry count, limit, threshold or none. A
  none drops the candidate only on the guideline sentence naming the kinds; an inline number of a
  named kind stays a finding. Every comment next to a named constant is listed, and the judge says
  whether one gives a cause for the amount (`why`) or only names what the value counts (`what`);
  only a `why` on a listed comment settles the constant. Two reasons are facts and settle it
  without a call: a sentence that ties the value to a document, URL or standard it names ("The
  stale age docs/contributing.md sets."), and a sentence that says what a smaller or larger value
  fails ("long enough to name the cause, short enough for one log line").

- It may drop the candidate only by copying the guideline sentence it rests on and one of the
  listed comments. A drop without both keeps the finding.
- An unreadable reply is asked once more with the same request; a second one leaves no finding
  and counts as `errors.judgeFailed` in the stats ledger.
- Its reason joins the finding only when it names no matcher or locator other than the fix.

The finding's title, body, quoted guideline sentence and suggestion come from the check, so a
rerun on the same change posts the same words. The report carries a `checks` tally: candidates,
findings, drops and judge failures.

## Facts only, with no model

With `model.provider: none` no judge runs. A candidate the check measured as a fact is a finding
exactly as above: its guideline sentence, severity, comment, task and gate. A candidate that
carries a judge question becomes no finding, no comment and no task and never touches the gate;
the log and the report's `factsOnly.leftToPerson` list it as `left to a person: needs a
judgement`, with file, line and the question. A guideline no check owns is not reviewed and is
named in `factsOnly.notReviewed`. The summary comment opens with one sentence, such as:

> This review checked facts only, with no model: 2 findings, 3 candidates left to a person because
> they need a judgement, and 1 guideline not reviewed (no-console).

and the commit status reads `Facts only, no model. 2 findings, 3 left to a person, 1 guideline not
reviewed.` The stats ledger records model `none`, zero tokens and zero cost.

Every candidate that carries a judge question is left to a person, except a number whose purpose
the code states in so many words:

| Shape                            | A finding with no model                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Left to a person                                                                                                                                                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `selectors`, CSS or derived hook | no comment at all on the line, above it or on its declaration (never judged)                                                                                                                                                                                                                                                                                                                                                                                                                                         | a comment is there and names no locator vocabulary and no because                                                                                                                                                                                          |
| `comments`, narration            | never                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | every comment the narration words flag                                                                                                                                                                                                                     |
| `numbers`, named constant        | no comment next to it, and a word of its name says what it is for: `timeout`, `ttl`, `delay`, `interval`, `backoff`, `retry`, `retries`, `attempt(s)`, `limit`, `max(imum)`, `min(imum)`, `cap`, `ceiling`, `threshold`                                                                                                                                                                                                                                                                                              | a comment that is neither a named source nor a bound, or a name with none of these words                                                                                                                                                                   |
| `numbers`, inline number         | the value of a key, a `??` or `\|\|` default, or a comparison whose own name says so (`timeout: 5000`, `options.attempts ?? 3`, `attempt < 2`), a `.default()` on such a key (`maxTokens: z.number().default(4000)`), a `.length` or `.size` held under or over a bound above two (`items.length > 37`, the guideline's own Bad example), a `setTimeout` or `setInterval` delay, an argument of a call named for a timeout, delay, retry or limit (`AbortSignal.timeout(7500)`), a `sleep()` call or a shell `sleep` | every other number, among them a regex quantifier (`/^\d{5}$/`), a `slice`, `substring` or `substr` argument (`sha.slice(0, 12)`), an argument of `Math.min`, `Math.max`, `.min()` or `.max()`, and every number in a test file or under a fixtures folder |

A quantifier, a cut, a clamp, an exact count (`segments.length === 3`) and a pair check
(`group.length < 2`) are ordinary code far more often than a limit the guideline means, so the
mode never decides them; a literal in a test may only describe the case, as the guideline allows. A constant named for an exit or status code (`CELL_TIMEOUT_EXIT_CODE = 124`) and a status
code compared or set (`res.status === 429`) are no candidates at all. What only a judgement finds,
the mode gives up.

## When the model cannot run

A review with a model configured falls back to facts only, with no change to the pipeline, when
the model cannot run:

| Cause                    | What counts                                                                                                    | The summary says                                       | The status says       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------- |
| no model is configured   | `model.id` or the provider's credential is not set                                                             | no model is configured                                 | `not configured`      |
| the provider unreachable | a refused, reset or unresolved connection, or an answer of 500 or above                                        | the model provider could not be reached                | `unreachable`         |
| a rate or quota limit    | an answer of 429, or one that names a rate limit, a quota, throttling or the credit balance, after the retries | the model provider answered with a rate or quota limit | `rate or quota limit` |
| a timeout                | a request past `model.timeoutSeconds` (default 60), `ETIMEDOUT`, or a connect, header or body timeout          | the model call timed out                               | `timed out`           |
| a refused credential     | an answer of 401 or 403, or one that says the key or the security token is invalid                             | the credential was refused                             | `credential refused`  |

Any other failure, an unreadable reply among them, fails the run as before, and so do the
ensemble and calibration calls, which keep their own handling. The log says
`model unavailable (<cause>): <what the call said>; falling back to facts only`, and the review
goes on as above: facts are findings, the rest is left to a person, and the report's
`factsOnly.fallback` names the cause. The summary opens with:

> The model could not run (the model provider could not be reached), so this review checked facts
> only: 1 finding, 1 candidate left to a person because it needs a judgement, and 1 guideline not
> reviewed (no-console). Merging needs a person's approval.

Each request to the provider may take `model.timeoutSeconds` (default 60, env
`DELTA_PEACOCK_MODEL_TIMEOUT_SECONDS`), long enough for a reply of the default 4000 output tokens;
a provider that takes the request and never answers counts as a timeout after that time.

When the diff is reviewed in batches and only some answer, the findings of the answered batches
stand and the summary names the files no model reviewed:

> The model reviewed part of the change, then could not run (the model provider could not be
> reached): no model reviewed src/other.ts, where this review checked facts only. ...

When the open review answered and the judge then cannot reach the model, the judge is asked once
in the run: that candidate and every later one settle as they would with no model, and the summary
says so:

> The model reviewed the change, but the judge could not run (the model provider answered with a
> rate or quota limit): 2 findings, and 5 candidates left to a person because they need a
> judgement. Merging needs a person's approval.

An outage on the second request for a readable answer counts like any other outage. A fallback
run never resolves or rewrites a comment an earlier run posted: it cannot judge the finding
again, so the comment stays as it is, the summary lists it (`Not judged again on this run, so
their comments stay as they are: src/app.ts:5.`), and the next run with the model settles it.

Three settings under `fallback` decide what the step and the status do; each default is the
recommended one.

| Setting                      | Default    | The other value                                                                        |
| ---------------------------- | ---------- | -------------------------------------------------------------------------------------- |
| `fallback.gate`              | `facts`    | `pass`: no fact fails the step; the findings stay in the summary, a model's still gate |
| `fallback.status`            | `success`  | `pending`: the status never reads as a pass (Bitbucket `INPROGRESS`, a card `PENDING`) |
| `fallback.credentialRefused` | `fallback` | `fail`: a refused credential fails the run with exit code 1, as any other error        |

With `fallback.gate: facts` a fact finding that reaches `gate.failOn` fails the step with exit
code 2 and a `failure` status that reads `No model (unreachable), facts only: 1 finding, 1 left to
a person. Needs a person's approval.`; otherwise the step exits 0. A finding the model gave before
it stopped gates as in any review, with either value. When the facts pass, the status
is `success` with the text `Facts only, no model: needs a person's approval` (`Model reviewed in
part: ...` or `Judge could not run: ...` when the model reviewed some or all of the change), or with
`fallback.status: pending` a `pending` status with the text above. The summary asks for a person's
approval in every case. Where the status is a required check, `pending` makes the merge wait for a
person, who merges past it or runs the review again once the model is back; `success` lets the
merge through and leaves the approval to the reviewers who read the summary. The environment
variables are `DELTA_PEACOCK_FALLBACK_GATE`, `DELTA_PEACOCK_FALLBACK_STATUS` and
`DELTA_PEACOCK_FALLBACK_CREDENTIAL_REFUSED`.

```yaml
fallback:
  gate: facts
  status: success
  credentialRefused: fallback
```

## The sentence each check quotes

Every check declares the guideline sentence it enforces, one per kind of candidate, and every
finding it produces quotes that sentence. The comment shows it as a `Guideline: ...` line under
the reason, like a model finding; the Code Insights annotation ends with the same line and the
stats ledger's finding line carries it as `guidelineQuote`.

| Check        | Candidate                          | Sentence the bound guideline must contain                                                                                                                                                      |
| ------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `selectors`  | every kind                         | Where a CSS selector is unavoidable, a comment next to it gives the reason.                                                                                                                    |
| `comments`   | a comment spanning lines           | Any punctuation may appear, semicolons as well, except dashes and doubled hyphens, and a comment never runs past a single line unless it is a doc comment.                                     |
| `comments`   | a dash, narration                  | It says nothing about how the change was made, the work session or who wrote it, and it separates clauses with commas or colons instead of dashes.                                             |
| `assertions` | a snapshot read                    | An assertion hands expect the locator itself and lets a web first matcher wait, never the awaited value of a getter.                                                                           |
| `tags`       | an undeclared tag                  | A test carries only axis tags and the feature tags the config declares, never `@smoke` or another tag the config does not list.                                                                |
| `tags`       | a tag in the title                 | Tags belong in the tag option, never in the test title.                                                                                                                                        |
| `timeouts`   | `waitForTimeout`                   | waitForTimeout has no valid use.                                                                                                                                                               |
| `timeouts`   | another sleep, an inline timeout   | Waits longer than the framework defaults live as named values in one timeouts module, which then explains every slow run in one place.                                                         |
| `numbers`    | an inline number, a named constant | Every timeout, delay, retry count, limit or threshold is a named constant declared once, next to the reason it has that value, so one place answers why the code waits or stops where it does. |
| `rows`       | a test copied but for its literals | Sites, products, payment methods and addresses become data rows of one scenario.                                                                                                               |
| `pattern`    | every kind                         | The guideline's own `message`, checked when the guidelines load.                                                                                                                               |

At startup the review confirms that each bound guideline says its check's sentences word for word
(whitespace, backticks and emphasis aside). A missing sentence is a configuration error: the run
stops with exit code 1 before any model call and posts nothing, and `doctor` fails its guidelines
check with the same message. Add the sentence to the guideline or unbind the check.
