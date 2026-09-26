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
```

The key is the guideline id, the value one of the five checks below. Every check looks only at
added lines, in files the guideline's own `paths` and `languages` cover. The open review still
reads the whole corpus, so its prompt does not change; a finding it reports under a checked
guideline is dropped and logged as `checked`.

## The checks

| Check        | A candidate is                                                                                                                                                                                                                                                                                                  | The fix it names                                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `selectors`  | a `.locator(...)` whose selector is CSS, a plain test id wrapped in CSS, a test id prefix (`[data-testid^="..."]`), test ids joined into a CSS list, a derived hook (a helper call with a `suffix`) or any other attribute selector such as `[data-ref="${title}"]`, string or template, with no reason comment | `getByTestId('id')` for a test id, a `getByTestId` regex for a prefix or a list, `or()` for a list, a reason comment or `getByRole` for other CSS   |
| `comments`   | a comment on a changed line that spans lines, uses a dash as punctuation, or tells the story of the change                                                                                                                                                                                                      | the comment folded into one line, the dash turned into a comma                                                                                      |
| `assertions` | a snapshot read inside `expect` or passed to its matcher: `isVisible()`, `textContent()`, `count()`, `url()`, `cookies()`, `evaluate()` and the rest, a page object method whose body makes one, or an awaited page object method whose body reads the browser                                                  | the web first matcher for what was read: `toHaveURL`, `toBeVisible`, `toHaveText`, `toHaveCount`, and so on; `expect.poll` for any other page state |
| `tags`       | a tag in the tag option that `review.repoConfigPath` does not declare, or a tag in the test title                                                                                                                                                                                                               | the tag list without it, or the tag moved into the option                                                                                           |
| `timeouts`   | `waitForTimeout(...)`, a sleep helper (`sleep`, `delay`, `pause`, `wait`) or `setTimeout` with a literal number, and a `timeout`, `delay` or `intervals` option holding a literal number or a local numeric constant; zero is no wait                                                                           | a named entry in the repository's `timeouts` file passed in its place, or a web first wait on the state the sleep stands in for                     |

A reason comment counts on the line, the line above, above the statement, heading a group of
declarations (single line ones, or a run of multi-line ones with no blank line between), in the
doc comment of the enclosing function, or on the declaration of a constant the selector uses. It
counts when it names the locator vocabulary (test id, role, class, attribute, shadow root) or
gives a because. A helper call with a `suffix` builds a derived hook attribute that `getByTestId`
cannot read; it is still CSS, so it needs the same comment.

## Facts and the judge

Most candidates are measured facts and become findings without a model call. One kind turns on
prose: a CSS selector near a comment that names no reason, and a comment that may narrate the
change. For those the judge answers one question per candidate.

- It may drop the candidate only by copying the guideline sentence it rests on and one of the
  listed comments. A drop without both keeps the finding.
- An unreadable reply is asked once more with the same request; a second one leaves no finding
  and counts as `errors.judgeFailed` in the stats ledger.
- Its reason joins the finding only when it names no matcher or locator other than the fix.

The finding's title, body, quoted guideline sentence and suggestion come from the check, so a
rerun on the same change posts the same words. The report carries a `checks` tally: candidates,
findings, drops and judge failures.
