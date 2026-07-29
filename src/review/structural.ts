import { analyzeScope, isInsideLoop, isModuleScope, type LineScope } from "../context/scope.js";
import type { Finding } from "../domain/finding.js";
import type { Guideline, StructuralCheck } from "../domain/guideline.js";
import { REJECTED_RAW_CAP, type RejectedCandidate } from "./parse.js";

export interface StructuralVerifyResult {
  kept: Finding[];
  /** One entry per dropped finding, reason `structural:<check>`, for the report and --explain-drops. */
  dropped: RejectedCandidate[];
}

/** True when the AST contradicts the finding sitting at this line -- drop it. */
type Contradicts = (scope: LineScope | undefined) => boolean;

function contradictsFor(check: StructuralCheck): Contradicts {
  return check === "no-declaration-in-loop"
    ? (scope) => !isInsideLoop(scope)
    : (scope) => !isModuleScope(scope);
}

/** The check a finding's own cited guideline opts into; undefined means nothing to verify. */
function checkFor(
  finding: Finding,
  guidelinesById: ReadonlyMap<string, Guideline>,
): StructuralCheck | undefined {
  if (finding.kind !== "violation") return undefined; // an observation cites no guideline to key on
  return guidelinesById.get(finding.guidelineId)?.structural;
}

/**
 * Deterministic post-parse gate (ADR 0008: unlike calibration, a fact the AST
 * itself settles may drop a finding outright, not just annotate it). Scoped
 * narrowly to whatever a guideline opts into via its `structural`
 * frontmatter field -- no guideline id is ever hardcoded here, so the corpus
 * decides what gets verified. Error-tolerant like the enricher it shares
 * `analyzeScope` with: unreadable or unparseable source can't refute
 * anything, so the finding it would have judged simply passes through.
 */
export function verifyStructural(
  findings: readonly Finding[],
  guidelinesById: ReadonlyMap<string, Guideline>,
  sourceOf: (file: string) => string | undefined,
): StructuralVerifyResult {
  // one parse per file, however many findings on it need a check, and none
  // at all for a file whose findings need no verification
  const linesByFile = new Map<string, Set<number>>();
  for (const finding of findings) {
    if (checkFor(finding, guidelinesById) === undefined) continue;
    const lines = linesByFile.get(finding.file) ?? new Set<number>();
    lines.add(finding.line);
    linesByFile.set(finding.file, lines);
  }
  const scopesByFile = new Map<string, ReturnType<typeof analyzeScope>>();
  for (const [file, lines] of linesByFile) {
    const source = sourceOf(file);
    if (source === undefined) continue;
    scopesByFile.set(file, analyzeScope(source, [...lines]));
  }

  const kept: Finding[] = [];
  const dropped: RejectedCandidate[] = [];
  for (const finding of findings) {
    const check = checkFor(finding, guidelinesById);
    const analysis = check === undefined ? undefined : scopesByFile.get(finding.file);
    if (check === undefined || !analysis?.parsed) {
      kept.push(finding); // nothing to verify, or nothing verification can trust
      continue;
    }
    if (!contradictsFor(check)(analysis.lines.get(finding.line))) {
      kept.push(finding);
      continue;
    }
    dropped.push({
      reason: `structural:${check}`,
      raw: JSON.stringify(finding).slice(0, REJECTED_RAW_CAP),
      ...(finding.kind === "violation" ? { guidelineId: finding.guidelineId } : {}),
      title: finding.title,
      severity: finding.severity,
    });
  }
  return { kept, dropped };
}
