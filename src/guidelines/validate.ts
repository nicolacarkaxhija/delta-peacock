import { approximateTokens } from "../context/port.js";
import type { Guideline } from "../domain/guideline.js";
import { renderGuideline } from "../review/prompt.js";
import { isKnownLanguage } from "./languages.js";

/** A single guideline past this many tokens strains the cacheable prefix. */
export const GUIDELINE_TOKEN_BUDGET = 1500;

/** Phrasing a linter or formatter enforces better than a review can. */
const MACHINE_CHECKABLE =
  /\b(single quote|double quote|semicolon|indent|tab|trailing whitespace|line length|import order|sort (?:the )?imports|max(?:imum)? line)/i;

/** Hard failures: a guideline with these is not usable as written. */
export function guidelineProblems(guideline: Guideline): string[] {
  const problems: string[] = [];
  if (guideline.body === "") {
    problems.push(
      `${guideline.sourcePath}: empty body; a guideline needs its expectations spelled out`,
    );
  }
  for (const language of guideline.languages) {
    if (!isKnownLanguage(language)) {
      problems.push(`${guideline.sourcePath}: unknown language "${language}"`);
    }
  }
  return problems;
}

/** Advisory: the guideline works, but something about it is worth reconsidering. */
export function guidelineWarnings(guideline: Guideline): string[] {
  const warnings: string[] = [];
  const tokens = approximateTokens(renderGuideline(guideline));
  if (tokens > GUIDELINE_TOKEN_BUDGET) {
    // guidelines are never chunked, so an oversized one bloats every prompt
    warnings.push(
      `${guideline.sourcePath}: about ${String(tokens)} tokens, over the ${String(GUIDELINE_TOKEN_BUDGET)}-token budget; consider splitting it`,
    );
  }
  if (MACHINE_CHECKABLE.test(guideline.body)) {
    warnings.push(
      `${guideline.sourcePath}: reads machine-checkable; a linter or formatter enforces this more cheaply than a review`,
    );
  }
  return warnings;
}
