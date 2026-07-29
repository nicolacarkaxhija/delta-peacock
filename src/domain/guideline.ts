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
}
