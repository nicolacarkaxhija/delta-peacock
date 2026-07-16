export interface ExpectedFinding {
  file: string;
  line: number;
  /** When set, only a finding citing this guideline can match. */
  guidelineId?: string;
}

export interface ProducedFinding {
  file: string;
  line: number;
  guidelineId?: string;
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
  return true;
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
  const names = Object.keys(byVariant);
  const keySets = new Map(
    names.map((name) => [name, new Set((byVariant[name] ?? []).map(findingKey))] as const),
  );
  const matrix: Record<string, Record<string, number>> = {};
  for (const a of names) {
    matrix[a] = {};
    for (const b of names) {
      let overlap = 0;
      for (const key of keySets.get(a) ?? []) {
        if (keySets.get(b)?.has(key) === true) overlap += 1;
      }
      matrix[a][b] = overlap;
    }
  }
  return matrix;
}
