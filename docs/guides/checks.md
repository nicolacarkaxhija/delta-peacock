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
| `comments`   | a comment on a changed line that spans lines, uses a dash as punctuation, or tells the story of the change                                                                                                                                                                                                      | the comment folded into one line, the dash turned into a comma                                                                                      |
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

Every candidate that carries a judge question is left to a person: a CSS selector near a comment
that names no reason, a comment that may narrate, and every number of the `numbers` check. A CSS
selector with no comment at all carries no question and stays a finding. The mode gives up what
only a judgement finds; it adds nothing a model review would not report.

## The sentence each check quotes

Every check declares the guideline sentence it enforces, one per kind of candidate, and every
finding it produces quotes that sentence. The comment shows it as a `Guideline: ...` line under
the reason, like a model finding; the Code Insights annotation ends with the same line and the
stats ledger's finding line carries it as `guidelineQuote`.

| Check        | Candidate                          | Sentence the bound guideline must contain                                                                                                                                                      |
| ------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `selectors`  | every kind                         | Where a CSS selector is unavoidable, a comment next to it gives the reason.                                                                                                                    |
| `comments`   | a comment spanning lines           | Any punctuation may appear, semicolons as well, except dashes and doubled hyphens, and a comment never runs past a single line.                                                                |
| `comments`   | a dash, narration                  | It says nothing about how the change was made, the work session or who wrote it, and it separates clauses with commas or colons instead of dashes.                                             |
| `assertions` | a snapshot read                    | What counts is the read itself: expect wrapped around an awaited getter.                                                                                                                       |
| `tags`       | an undeclared tag                  | Only axis tags and tags the config declares are accepted, so a suggestion never proposes `@smoke` or another unlisted word; the test's folder states its intent already.                       |
| `tags`       | a tag in the title                 | Tags belong in the tag option, never in the test title.                                                                                                                                        |
| `timeouts`   | `waitForTimeout`                   | waitForTimeout has no valid use.                                                                                                                                                               |
| `timeouts`   | another sleep, an inline timeout   | Waits longer than the framework defaults live as named values in one timeouts module, which then explains every slow run in one place.                                                         |
| `numbers`    | an inline number, a named constant | Every timeout, delay, retry count, limit or threshold is a named constant declared once, next to the reason it has that value, so one place answers why the code waits or stops where it does. |
| `rows`       | a test copied but for its literals | Sites, products, payment methods and addresses become data rows of one scenario.                                                                                                               |

At startup the review confirms that each bound guideline says its check's sentences word for word
(whitespace, backticks and emphasis aside). A missing sentence is a configuration error: the run
stops with exit code 1 before any model call and posts nothing, and `doctor` fails its guidelines
check with the same message. Add the sentence to the guideline or unbind the check.
