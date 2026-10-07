import type { Guideline } from "../../domain/guideline.js";
import { quotesGuideline } from "../parse.js";
import type { CheckName, Shape } from "./detect.js";

const CSS_REASON = "Where a CSS selector is unavoidable, a comment next to it gives the reason.";
const NAMED_WAIT =
  "Waits longer than the framework defaults live as named values in one timeouts module, which then explains every slow run in one place.";

const NAMED_NUMBER =
  "Every timeout, delay, retry count, limit or threshold is a named constant declared once, next to the reason it has that value, so one place answers why the code waits or stops where it does.";

/** The guideline sentence each check enforces, per shape it reports; quoted on every finding. */
export const CHECK_SENTENCES: Readonly<
  Record<CheckName, Readonly<Partial<Record<Shape, string>>>>
> = {
  selectors: {
    "test-id": CSS_REASON,
    "test-id-list": CSS_REASON,
    "test-id-prefix": CSS_REASON,
    "derived-hook": CSS_REASON,
    css: CSS_REASON,
  },
  comments: {
    "multi-line":
      "Any punctuation may appear, semicolons as well, except dashes and doubled hyphens, and a comment never runs past a single line unless it is a doc comment.",
    dash: "It says nothing about how the change was made, the work session or who wrote it, and it separates clauses with commas or colons instead of dashes.",
    narration:
      "It says nothing about how the change was made, the work session or who wrote it, and it separates clauses with commas or colons instead of dashes.",
  },
  assertions: {
    snapshot:
      "An assertion hands expect the locator itself and lets a web first matcher wait, never the awaited value of a getter.",
  },
  tags: {
    "undeclared-tag":
      "A test carries only axis tags and the feature tags the config declares, never `@smoke` or another tag the config does not list.",
    "title-tag": "Tags belong in the tag option, never in the test title.",
  },
  timeouts: {
    "wait-for-timeout": "waitForTimeout has no valid use.",
    sleep: NAMED_WAIT,
    "inline-timeout": NAMED_WAIT,
  },
  numbers: {
    "inline-number": NAMED_NUMBER,
    "unexplained-constant": NAMED_NUMBER,
  },
  rows: {
    copy: "Sites, products, payment methods and addresses become data rows of one scenario.",
  },
  // each guideline names its own sentence in its check's message
  pattern: {},
};

/** The sentence a check quotes for a shape it reports. */
export function sentenceOf(check: CheckName, shape: Shape): string {
  const sentence = CHECK_SENTENCES[check][shape];
  if (sentence === undefined)
    throw new Error(`the ${check} check declares no sentence for ${shape}`);
  return sentence;
}

/** The first check whose every sentence the guideline says word for word; its measurements are facts no open review may contradict. */
export function impliedCheck(guideline: Guideline): CheckName | undefined {
  for (const [check, shapes] of Object.entries(CHECK_SENTENCES) as [
    CheckName,
    Partial<Record<Shape, string>>,
  ][]) {
    const sentences = new Set(Object.values(shapes));
    if (sentences.size === 0) continue;
    if ([...sentences].every((sentence) => quotesGuideline(sentence, guideline))) return check;
  }
  return undefined;
}

/** Each bound guideline must say its check's sentences word for word; one problem per missing sentence. */
export function checkSentenceProblems(
  guidelines: readonly Guideline[],
  bindings: Readonly<Record<string, CheckName>>,
): string[] {
  const problems: string[] = [];
  for (const guideline of guidelines) {
    const check = bindings[guideline.id];
    if (check === undefined) continue;
    for (const sentence of new Set(Object.values(CHECK_SENTENCES[check]))) {
      if (quotesGuideline(sentence, guideline)) continue;
      problems.push(
        `review.checks: ${guideline.id} is bound to the ${check} check, which quotes "${sentence}", but ${guideline.sourcePath} does not say it word for word; add the sentence or unbind the check`,
      );
    }
  }
  return problems;
}
