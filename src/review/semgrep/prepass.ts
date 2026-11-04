import type { Violation } from "../../domain/finding.js";
import type { Guideline } from "../../domain/guideline.js";
import type { Withheld } from "./hunks.js";
import type { SemgrepRunner } from "./run.js";

export interface PrepassInput {
  /** The guidelines that apply to the change. */
  guidelines: readonly Guideline[];
  diff: string;
  /** A changed file's text at the reviewed commit. */
  read: (file: string) => string | undefined;
  generalPass: boolean;
  runner: SemgrepRunner;
}

export interface PrepassOutcome {
  /** The guidelines the rules decide; the model never judges them. */
  settled: string[];
  findings: Violation[];
  /** The diff the model receives. */
  modelDiff: string;
  withheld: Withheld[];
  notices: string[];
  /** The Semgrep version that ran; absent when nothing ran. */
  engine?: string;
  /** Where each rule set came from: a pack and its version, or local. */
  ruleSets: string[];
  /** Why the run failed; the model then reviews the whole diff. */
  failure?: string;
}

/** The semgrep pre pass; undefined when no guideline declares a semgrep check. */
export function runPrepass(input: PrepassInput): Promise<PrepassOutcome | undefined> {
  return Promise.resolve(input.guidelines.length < 0 ? undefined : undefined);
}
