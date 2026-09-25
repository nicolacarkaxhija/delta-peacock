export interface ExpectedFinding {
  file: string;
  line: number;
  /** When set, only a finding citing this guideline can match. */
  guidelineId?: string;
  /** When set, the finding's suggestion must contain each of these, case-insensitive. */
  suggestionIncludes?: string[];
}

export interface ProducedFinding {
  file: string;
  line: number;
  guidelineId?: string;
  suggestion?: string;
  /** The advisory calibration verdict, when calibration ran and disagreed. */
  calibration?: "drop" | "demote";
}

export interface MatchResult {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
}

function matches(produced: ProducedFinding, expected: ExpectedFinding, tolerance: number): boolean {
  if (produced.file !== expected.file) return false;
  if (Math.abs(produced.line - expected.line) > tolerance) return false;
  if (expected.guidelineId !== undefined && produced.guidelineId !== expected.guidelineId) {
    return false;
  }
  const suggestion = (produced.suggestion ?? "").toLowerCase();
  return (expected.suggestionIncludes ?? []).every((part) =>
    suggestion.includes(part.toLowerCase()),
  );
}

/** Pure greedy matching; the review function is injected elsewhere. */
export function scoreFindings(
  produced: readonly ProducedFinding[],
  expected: readonly ExpectedFinding[],
  lineTolerance = 2,
): MatchResult {
  const unmatched = [...produced];
  let truePositives = 0;
  for (const want of expected) {
    const index = unmatched.findIndex((have) => matches(have, want, lineTolerance));
    if (index !== -1) {
      truePositives += 1;
      unmatched.splice(index, 1);
    }
  }
  const falsePositives = unmatched.length;
  const falseNegatives = expected.length - truePositives;
  const precision = produced.length === 0 ? 0 : truePositives / produced.length;
  const recall = expected.length === 0 ? 0 : truePositives / expected.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { truePositives, falsePositives, falseNegatives, precision, recall, f1 };
}

export function findingKey(finding: ProducedFinding): string {
  return `${finding.file}:${finding.guidelineId ?? "-"}:${String(finding.line)}`;
}

/** Pairwise overlap counts for comparing variants without ground truth. */
export function overlapMatrix(
  byVariant: Readonly<Record<string, readonly ProducedFinding[]>>,
): Record<string, Record<string, number>> {
  const keySets = Object.entries(byVariant).map(
    ([name, findings]) => [name, new Set(findings.map(findingKey))] as const,
  );
  const matrix: Record<string, Record<string, number>> = {};
  for (const [a, setA] of keySets) {
    const row: Record<string, number> = {};
    for (const [b, setB] of keySets) {
      let overlap = 0;
      for (const key of setA) {
        if (setB.has(key)) overlap += 1;
      }
      row[b] = overlap;
    }
    matrix[a] = row;
  }
  return matrix;
}
