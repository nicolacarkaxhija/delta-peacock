import type { Severity } from "../domain/severity.js";
import type { ExpectedFinding, NoFinding } from "./cases.js";

/** One finding a replayed review published, as its report holds it. */
export interface ReplayedFinding {
  file: string;
  line: number;
  guidelineId?: string;
  severity: Severity;
  title: string;
  body: string;
  suggestion?: string;
}

export interface WrongFinding {
  finding: ReplayedFinding;
  reason: string;
}

export interface RunScore {
  expected: number;
  found: number;
  right: number;
  wrong: WrongFinding[];
  missed: ExpectedFinding[];
}

interface Span {
  file: string;
  line: number;
  endLine?: number | undefined;
}

function covers(entry: Span, finding: ReplayedFinding): boolean {
  return (
    entry.file === finding.file &&
    finding.line >= entry.line &&
    finding.line <= (entry.endLine ?? entry.line)
  );
}

function sameGuideline(
  entry: { guidelineId?: string | undefined },
  finding: ReplayedFinding,
): boolean {
  return entry.guidelineId === undefined || entry.guidelineId === finding.guidelineId;
}

/** Why a finding on the expected span still fails the judgement, or undefined when it holds. */
function contentProblem(want: ExpectedFinding, have: ReplayedFinding): string | undefined {
  if (want.severity !== undefined && want.severity !== have.severity) {
    return `severity ${have.severity}, the judgement says ${want.severity}`;
  }
  const text = `${have.title}\n${have.body}\n${have.suggestion ?? ""}`.toLowerCase();
  const unmentioned = (want.mustMention ?? []).filter((part) => !text.includes(part.toLowerCase()));
  if (unmentioned.length > 0) return `does not mention ${unmentioned.join(", ")}`;
  const suggestion = (have.suggestion ?? "").toLowerCase();
  const banned = (want.mustNotSuggest ?? []).filter((part) =>
    suggestion.includes(part.toLowerCase()),
  );
  if (banned.length > 0) return `suggests ${banned.join(", ")}`;
  return undefined;
}

/**
 * Scores one replayed review against the human judgement. Every finding is
 * either right (on an expected span, same guideline, severity and wording
 * checks hold) or wrong, named with its reason; nothing is left unjudged.
 */
export function scoreRun(
  produced: readonly ReplayedFinding[],
  expected: readonly ExpectedFinding[],
  noFinding: readonly NoFinding[],
): RunScore {
  const open = [...expected];
  const wrong: WrongFinding[] = [];
  let right = 0;
  for (const finding of produced) {
    const index = open.findIndex((want) => covers(want, finding) && sameGuideline(want, finding));
    const want = open[index];
    if (want !== undefined) {
      open.splice(index, 1);
      const problem = contentProblem(want, finding);
      if (problem === undefined) right += 1;
      else wrong.push({ finding, reason: problem });
      continue;
    }
    const known = noFinding.find(
      (entry) => covers(entry, finding) && sameGuideline(entry, finding),
    );
    const repeated = expected.some(
      (entry) => covers(entry, finding) && sameGuideline(entry, finding),
    );
    wrong.push({
      finding,
      reason:
        known !== undefined
          ? `judged wrong before${known.why !== undefined ? `: ${known.why}` : ""}`
          : repeated
            ? "a second finding on a span already flagged"
            : "not in the human judgement",
    });
  }
  return { expected: expected.length, found: produced.length, right, wrong, missed: open };
}

/** The identity a finding keeps across repeats: where it sits and what it cites. */
export function findingKey(finding: ReplayedFinding): string {
  return `${finding.file}:${String(finding.line)}:${finding.guidelineId ?? "-"}`;
}

/** Findings present in some repeats but not all; zero means the review is stable. */
export function drift(repeats: readonly (readonly ReplayedFinding[])[]): number {
  if (repeats.length === 0) return 0;
  const sets = repeats.map((findings) => new Set(findings.map(findingKey)));
  const union = new Set(sets.flatMap((set) => [...set]));
  let shared = 0;
  for (const key of union) if (sets.every((set) => set.has(key))) shared += 1;
  return union.size - shared;
}
