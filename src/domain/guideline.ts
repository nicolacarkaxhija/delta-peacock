import type { Severity } from "./severity.js";

/**
 * Deterministic post-parse checks a guideline can opt into via its
 * `structural` frontmatter field (ADR 0008: unlike calibration, a check the
 * AST itself settles is a fact, not an opinion, so it may drop a finding
 * outright). Declarative and closed-set on purpose: core verification logic
 * keys on this value, never on a guideline id, so the corpus opts in per
 * rule rather than the reviewer special-casing specific rules by name.
 */
export const STRUCTURAL_CHECKS = ["no-declaration-in-loop", "module-scope-only"] as const;

export type StructuralCheck = (typeof STRUCTURAL_CHECKS)[number];

/**
 * Static checks a guideline can be bound to in `review.checks`: the check
 * finds the candidate lines, and only those can become findings under it.
 */
export const GUIDELINE_CHECKS = [
  "selectors",
  "comments",
  "assertions",
  "tags",
  "timeouts",
  "numbers",
  "rows",
] as const;

export type GuidelineCheck = (typeof GUIDELINE_CHECKS)[number];

/**
 * A pattern a guideline declares under `check:` in its frontmatter: regexes
 * over added lines or whole changed files decide it, with no model.
 */
export interface PatternCheck {
  type: "pattern";
  /** Path globs on top of the guideline's own scope; empty means every file it covers. */
  files: readonly string[];
  /** A regex no added line may match. */
  added?: string;
  /** A regex whose match on the same line excuses an `added` match. */
  unless?: string;
  /** A regex every changed file the check covers must match somewhere. */
  absent?: string;
  /** At most this many findings per file. */
  maxPerFile?: number;
  /** The guideline sentence every finding quotes. */
  message: string;
}

export interface Guideline {
  id: string;
  severity: Severity;
  title: string;
  body: string;
  sourcePath: string;
  /** Empty means the guideline covers every language. */
  languages: readonly string[];
  /** Path globs the guideline is scoped to; empty means everywhere. */
  paths: readonly string[];
  tags: readonly string[];
  /** Name of the guideline pack this rule came from; absent for local rules. */
  pack?: string;
  /** Opts into a deterministic AST check on every finding this guideline produces; absent means none. */
  structural?: StructuralCheck;
  /** A pattern that decides the guideline by facts alone; absent means none. */
  check?: PatternCheck;
  /** Sentences of the guideline naming cases that are never a finding; each one is checked before a finding stands. */
  exclusions?: readonly string[];
}
