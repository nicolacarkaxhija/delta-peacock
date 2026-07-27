import type { RuntimeDeps } from "../deps.js";
import type { Guideline } from "../domain/guideline.js";
import { guidelineProblems, guidelineWarnings } from "./validate.js";

export interface LintScaffoldOptions {
  /** Problems already known before per-guideline checks run (loader or manifest problems). */
  problems: readonly string[];
  guidelines: readonly Guideline[];
  /** Names the run in the failing summary: "<label> failed with N problem(s)". */
  label: string;
  /** Printed via deps.out() once every guideline checks out. */
  successMessage: string;
}

/**
 * The warn-collection shape both guideline lints share: run every guideline
 * through the structural and warning checks, print an actionable failure
 * when problems pile up, otherwise report success. Callers own everything
 * upstream of "which guidelines were loaded" — corpus discovery, manifest
 * checks, notices — since that is where their two jobs actually differ.
 */
export function runLintScaffold(deps: RuntimeDeps, options: LintScaffoldOptions): number {
  const problems = [...options.problems];
  for (const guideline of options.guidelines) {
    problems.push(...guidelineProblems(guideline));
    for (const warning of guidelineWarnings(guideline)) deps.err(`warning: ${warning}\n`);
  }
  if (problems.length > 0) {
    for (const problem of problems) deps.err(`${problem}\n`);
    deps.err(`${options.label} failed with ${String(problems.length)} problem(s)\n`);
    return 1;
  }
  deps.out(options.successMessage);
  return 0;
}
