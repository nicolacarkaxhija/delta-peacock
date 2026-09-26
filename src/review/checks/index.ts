import type { Finding, Violation } from "../../domain/finding.js";
import type { Guideline } from "../../domain/guideline.js";
import { newLineTexts } from "../../git/diff.js";
import type { ModelPort, ModelUsage } from "../../model/port.js";
import { addUsage } from "../../model/usage.js";
import { inPool } from "../../util/pool.js";
import type { DeclaredTags } from "../declared.js";
import type { RejectedCandidate } from "../parse.js";
import type { CheckTally } from "../report.js";
import {
  findCandidates,
  testIdAttributeOf,
  type BoundGuideline,
  type CheckName,
} from "./detect.js";
import { excerptOf, settle } from "./judge.js";

export { CHECKS, type CheckName } from "./detect.js";

/** The guidelines a static check owns, and the ones the model reviews freely. */
export function splitChecked(
  guidelines: readonly Guideline[],
  bindings: Readonly<Record<string, CheckName>>,
): { bound: BoundGuideline[]; free: Guideline[] } {
  const bound: BoundGuideline[] = [];
  const free: Guideline[] = [];
  for (const guideline of guidelines) {
    const check = bindings[guideline.id];
    if (check === undefined) free.push(guideline);
    else bound.push({ guideline, check });
  }
  return { bound, free };
}

/** Open review findings under a checked guideline are dropped: only its check's lines count. */
export function dropChecked<T extends Finding>(
  findings: readonly T[],
  bound: readonly BoundGuideline[],
): { kept: T[]; dropped: RejectedCandidate[] } {
  const checked = new Set(bound.map(({ guideline }) => guideline.id));
  const kept: T[] = [];
  const dropped: RejectedCandidate[] = [];
  for (const finding of findings) {
    if (finding.kind === "violation" && checked.has(finding.guidelineId)) {
      dropped.push({
        reason: "checked",
        raw: JSON.stringify({ file: finding.file, line: finding.line, title: finding.title }),
        guidelineId: finding.guidelineId,
        title: finding.title,
      });
    } else {
      kept.push(finding);
    }
  }
  return { kept, dropped };
}

export interface ChecksInput {
  bound: readonly BoundGuideline[];
  /** The reviewed diff; its added lines are where candidates may sit. */
  diff: string;
  read: (file: string) => string | undefined;
  files: () => readonly string[];
  declared?: DeclaredTags;
  /** Where the repository names the attribute getByTestId reads. */
  configFiles: readonly string[];
  /** Built only when a candidate needs the judge. */
  port: () => ModelPort;
  /** Applied to every excerpt before it leaves the process. */
  redact: (text: string) => string;
}

export interface ChecksOutcome {
  findings: Violation[];
  rejected: RejectedCandidate[];
  notices: string[];
  tally: CheckTally;
  usage?: ModelUsage;
}

/** Judge calls in flight at once. */
const JUDGE_CONCURRENCY = 4;

/**
 * The checked guidelines' whole review: candidates from the static checks,
 * each settled as a fact or by the judge. Nothing else yields a finding for
 * a checked guideline, so a line no check flags is never one.
 */
export async function runChecks(input: ChecksInput): Promise<ChecksOutcome> {
  const changed = new Map<string, Set<number>>();
  for (const [file, lines] of newLineTexts(input.diff)) changed.set(file, new Set(lines.keys()));
  const candidates = findCandidates(input.bound, {
    changed,
    read: input.read,
    files: input.files,
    ...(input.declared !== undefined ? { declared: input.declared } : {}),
    testIdAttribute: testIdAttributeOf(input.configFiles.map((file) => input.read(file))),
  });
  let port: ModelPort | undefined;
  const outcomes = await inPool(
    input.bound.flatMap(({ guideline }) =>
      candidates
        .filter((candidate) => candidate.guidelineId === guideline.id)
        .map((candidate) => async () => {
          if (candidate.judge !== undefined) port ??= input.port();
          const lines = (input.read(candidate.file) ?? "").split("\n");
          return settle(port, candidate, guideline, input.redact(excerptOf(lines, candidate)));
        }),
    ),
    JUDGE_CONCURRENCY,
  );
  const findings: Violation[] = [];
  const rejected: RejectedCandidate[] = [];
  let usage: ModelUsage | undefined;
  const tally: CheckTally = {
    candidates: candidates.length,
    findings: 0,
    dropped: 0,
    judgeFailed: 0,
  };
  for (const outcome of outcomes) {
    if (outcome.finding !== undefined) findings.push(outcome.finding);
    if (outcome.rejected !== undefined) rejected.push(outcome.rejected);
    if (outcome.usage !== undefined)
      usage = usage === undefined ? outcome.usage : addUsage(usage, outcome.usage);
    if (outcome.outcome === "finding") tally.findings += 1;
    else if (outcome.outcome === "dropped") tally.dropped += 1;
    else tally.judgeFailed += 1;
  }
  return {
    findings,
    rejected,
    notices: outcomes.map((outcome) => outcome.notice),
    tally,
    ...(usage !== undefined ? { usage } : {}),
  };
}
