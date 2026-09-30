import type { Config } from "../../config/schema.js";
import type { Finding, Violation } from "../../domain/finding.js";
import type { Guideline } from "../../domain/guideline.js";
import { newLineTexts } from "../../git/diff.js";
import type { ModelPort, ModelUsage } from "../../model/port.js";
import { ModelUnavailableError } from "../../model/unavailable.js";
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
import {
  excerptOf,
  settle,
  type JudgedCandidate,
  type LeftCandidate,
  type ModelOutage,
} from "./judge.js";
import { impliedCheck } from "./rules.js";

export { CHECKS, type CheckName } from "./detect.js";
export { CHECK_SENTENCES, checkSentenceProblems, impliedCheck, sentenceOf } from "./rules.js";

/** The guidelines a static check owns, bound in the config or by their own words, and the ones the model reviews freely. */
export function splitChecked(
  guidelines: readonly Guideline[],
  bindings: Readonly<Record<string, CheckName>>,
): { bound: BoundGuideline[]; free: Guideline[] } {
  const bound: BoundGuideline[] = [];
  const free: Guideline[] = [];
  for (const guideline of guidelines) {
    const check = bindings[guideline.id] ?? impliedCheck(guideline);
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
  /** Built only when a candidate needs the judge; absent means no model, facts only. */
  port?: () => ModelPort;
  /** Applied to every excerpt before it leaves the process. */
  redact: (text: string) => string;
  /** Whether a refused credential leaves the judged candidates to a person; fallback when unset. */
  credentialRefused?: Config["fallback"]["credentialRefused"];
}

export interface ChecksOutcome {
  findings: Violation[];
  /** The findings no model judged; `fallback.gate: pass` keeps them from gating. */
  facts: Violation[];
  rejected: RejectedCandidate[];
  /** Candidates only a judgement settles, when no model runs. */
  left: LeftCandidate[];
  notices: string[];
  tally: CheckTally;
  usage?: ModelUsage;
  /** Set when the judge could not reach the model: its candidates were left to a person. */
  unavailable?: ModelOutage;
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
  let outage: ModelOutage | undefined;
  // a model that cannot be built leaves every judged candidate to a person
  const judge = (): ModelPort | undefined => {
    if (port !== undefined || outage !== undefined || input.port === undefined) return port;
    try {
      port = input.port();
    } catch (error) {
      if (!(error instanceof ModelUnavailableError)) throw error;
      outage = { why: error.why, detail: error.message };
    }
    return port;
  };
  const tasks = input.bound.flatMap(({ guideline }) =>
    candidates
      .filter((candidate) => candidate.guidelineId === guideline.id)
      .map((candidate) => ({
        judged: candidate.judge !== undefined,
        run: async (): Promise<JudgedCandidate> => {
          // after the first outage the judge is not asked again in this run
          const judgePort =
            candidate.judge !== undefined && outage === undefined ? judge() : undefined;
          const lines = (input.read(candidate.file) ?? "").split("\n");
          const settled = await settle(
            judgePort,
            candidate,
            guideline,
            input.redact(excerptOf(lines, candidate)),
            input.credentialRefused,
          );
          outage ??= settled.unavailable;
          return settled;
        },
      })),
  );
  // the first judged candidate goes alone, so an outage costs one call's retries, not one per call in flight
  const probe = tasks.findIndex((task) => task.judged);
  const probed = probe >= 0 ? await tasks[probe]?.run() : undefined;
  const rest = await inPool(
    tasks.filter((_, index) => index !== probe).map((task) => task.run),
    JUDGE_CONCURRENCY,
  );
  const outcomes =
    probed === undefined ? rest : [...rest.slice(0, probe), probed, ...rest.slice(probe)];
  const findings: Violation[] = [];
  const facts: Violation[] = [];
  const rejected: RejectedCandidate[] = [];
  const left: LeftCandidate[] = [];
  let usage: ModelUsage | undefined;
  const tally: CheckTally = {
    candidates: candidates.length,
    findings: 0,
    dropped: 0,
    judgeFailed: 0,
  };
  for (const outcome of outcomes) {
    if (outcome.finding !== undefined) findings.push(outcome.finding);
    if (outcome.finding !== undefined && outcome.fact === true) facts.push(outcome.finding);
    if (outcome.rejected !== undefined) rejected.push(outcome.rejected);
    if (outcome.left !== undefined) left.push(outcome.left);
    if (outcome.usage !== undefined)
      usage = usage === undefined ? outcome.usage : addUsage(usage, outcome.usage);
    if (outcome.outcome === "finding") tally.findings += 1;
    else if (outcome.outcome === "dropped") tally.dropped += 1;
    else if (outcome.outcome === "left") tally.left = (tally.left ?? 0) + 1;
    else tally.judgeFailed += 1;
  }
  return {
    findings,
    facts,
    rejected,
    left,
    notices: outcomes.map((outcome) => outcome.notice),
    tally,
    ...(usage !== undefined ? { usage } : {}),
    ...(outage !== undefined ? { unavailable: outage } : {}),
  };
}
