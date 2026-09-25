import type { Guideline } from "../domain/guideline.js";

export interface GuidelineExamples {
  good: string[];
  bad: string[];
}

const label = (words: string): RegExp =>
  new RegExp(
    `^\\s*(?:#+\\s*)?(?:\\*\\*|__)?(?:${words})(?:\\s+examples?)?(?:\\s*\\([^)]*\\))?\\s*:?\\s*(?:\\*\\*|__)?\\s*:?\\s*$`,
    "i",
  );
const GOOD_LABEL = label("good|correct|preferred|compliant|do");
const BAD_LABEL = label("bad|wrong|incorrect|avoid|don'?t|non-compliant");

/** The fenced code under each Good and Bad label of a guideline body. */
export function examplesOf(body: string): GuidelineExamples {
  const examples: GuidelineExamples = { good: [], bad: [] };
  let kind: "good" | "bad" | undefined;
  let fence: string[] | undefined;
  for (const line of body.split("\n")) {
    if (fence !== undefined) {
      if (/^\s*```/.test(line)) {
        if (kind !== undefined) examples[kind].push(fence.join("\n"));
        fence = undefined;
      } else fence.push(line);
      continue;
    }
    if (/^\s*```/.test(line)) fence = [];
    else if (GOOD_LABEL.test(line)) kind = "good";
    else if (BAD_LABEL.test(line)) kind = "bad";
    else if (line.startsWith("#")) kind = undefined;
  }
  return examples;
}

/** Whitespace collapsed and a trailing separator dropped, so layout never decides a match. */
export function normalizeCode(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim().replace(/[,;]$/, "").trim();
}

/** Below this a quote is too generic to call a match. */
const MIN_MATCH = 8;

/**
 * True when the quoted line appears verbatim in one of the guideline's Good
 * examples and in none of its Bad ones: code the rule itself shows as right
 * is never a finding under that rule.
 */
export function matchesGoodExample(quote: string, guideline: Guideline): boolean {
  const needle = normalizeCode(quote);
  if (needle.length < MIN_MATCH) return false;
  const { good, bad } = examplesOf(guideline.body);
  const within = (blocks: string[]) =>
    blocks.some((block) => normalizeCode(block).includes(needle));
  return within(good) && !within(bad);
}
