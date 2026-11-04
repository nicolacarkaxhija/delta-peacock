import type { Guideline } from "../../domain/guideline.js";

/** The rule file that sits next to a guideline file. */
export function rulesFileOf(guidelinePath: string): string {
  throw new Error(`not built: ${guidelinePath}`);
}

/** Which guideline and rule a combined rule id stands for. */
export interface RuleOwner {
  guideline: Guideline;
  rule: string;
}

/** Every guideline's rules in one config, each id prefixed with its guideline id. */
export function combinedRules(guidelines: readonly Guideline[]): {
  config: string;
  owners: Map<string, RuleOwner>;
} {
  throw new Error(`not built: ${String(guidelines.length)}`);
}
