import { fingerprintOf, type Finding, type ProposedGuideline } from "../domain/finding.js";
import type { GateDecision } from "../domain/gate.js";
import { SEVERITIES } from "../domain/severity.js";
import type { ScmPort, StatusState } from "./port.js";

const MARKER_PREFIX = "<!-- delta-peacock:";
const SUMMARY_MARKER = "<!-- delta-peacock:summary -->";
const FINDING_MARKER = /^<!-- delta-peacock:finding:([0-9a-f]+(?:-\d+)?) -->$/;

function findingMarker(fingerprint: string): string {
  return `${MARKER_PREFIX}finding:${fingerprint} -->`;
}

/** Only a marker on the comment's final line counts; quoting one in prose does not. */
function markerFingerprint(body: string): string | undefined {
  const lastLine = String(body.trimEnd().split("\n").at(-1));
  return FINDING_MARKER.exec(lastLine)?.[1];
}

export function renderCommentBody(finding: Finding, fingerprint: string): string {
  const cite =
    finding.kind === "violation" ? `\`${finding.guidelineId}\`` : "observation (general pass)";
  const lines = [`**${finding.severity}** ${finding.title} — ${cite}`, "", finding.body];
  if (finding.suggestion !== undefined) {
    lines.push("", "```suggestion", finding.suggestion, "```");
  }
  lines.push("", findingMarker(fingerprint));
  return lines.join("\n");
}

/** One unique fingerprint per finding, suffixing genuine collisions. */
export function fingerprintEntries(
  findings: readonly Finding[],
): { fingerprint: string; finding: Finding }[] {
  const used = new Map<string, number>();
  return findings.map((finding) => {
    const base = fingerprintOf(finding);
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    return { fingerprint: count === 0 ? base : `${base}-${String(count)}`, finding };
  });
}

function gateSummaryLine(gate: GateDecision): string {
  if (gate.threshold === "none") return "Gate: advisory.";
  if (gate.failed) {
    return `Gate: failOn=${gate.threshold} FAILED (${String(gate.failing)}).`;
  }
  return `Gate: failOn=${gate.threshold} passed.`;
}

export interface SummaryInput {
  findings: readonly Finding[];
  proposals: readonly ProposedGuideline[];
  droppedUncited: number;
  filtered: number;
  gate: GateDecision;
}

export function renderSummaryBody(input: SummaryInput): string {
  const bySeverity = new Map<string, number>();
  for (const finding of input.findings) {
    bySeverity.set(finding.severity, (bySeverity.get(finding.severity) ?? 0) + 1);
  }
  const rows = SEVERITIES.filter((severity) => bySeverity.has(severity)).map(
    (severity) => `| ${severity} | ${String(bySeverity.get(severity))} |`,
  );
  const lines = [
    "## delta-peacock review",
    "",
    input.findings.length === 0 ? "No findings." : "| Severity | Findings |\n| --- | --- |",
    ...rows,
    "",
    gateSummaryLine(input.gate),
  ];
  if (input.proposals.length > 0) {
    lines.push("", "### Proposed guidelines", "");
    for (const proposal of input.proposals) {
      lines.push(`- \`${proposal.id}\` (${proposal.severity}): ${proposal.rationale}`);
    }
  }
  if (input.filtered > 0 || input.droppedUncited > 0) {
    lines.push(
      "",
      `_${String(input.filtered)} finding(s) under the confidence floor; ${String(input.droppedUncited)} uncited finding(s) dropped._`,
    );
  }
  lines.push("", SUMMARY_MARKER);
  return lines.join("\n");
}

export interface PublishOutcome {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
}

async function reconcileInlineComments(
  scm: ScmPort,
  findings: readonly Finding[],
  outcome: PublishOutcome,
): Promise<void> {
  const desired = new Map(
    fingerprintEntries(findings).map(({ fingerprint, finding }) => [fingerprint, finding]),
  );
  const existing = (await scm.listInlineComments()).filter(
    (comment) => markerFingerprint(comment.body) !== undefined,
  );
  const seen = new Set<string>();
  for (const comment of existing) {
    const fingerprint = markerFingerprint(comment.body);
    /* v8 ignore next -- the filter above guarantees a marker; the guard survives refactors */
    const finding = fingerprint === undefined ? undefined : desired.get(fingerprint);
    if (fingerprint === undefined || finding === undefined || seen.has(fingerprint)) {
      await scm.deleteComment(comment.id);
      outcome.deleted += 1;
      continue;
    }
    seen.add(fingerprint);
    const body = renderCommentBody(finding, fingerprint);
    if (body === comment.body) {
      outcome.unchanged += 1;
    } else {
      await scm.updateComment(comment.id, body);
      outcome.updated += 1;
    }
  }
  for (const [fingerprint, finding] of desired) {
    if (seen.has(fingerprint)) continue;
    await scm.createInlineComment({
      body: renderCommentBody(finding, fingerprint),
      path: finding.file,
      line: finding.line,
    });
    outcome.created += 1;
  }
}

async function upsertSummary(scm: ScmPort, body: string): Promise<void> {
  const summary = (await scm.listSummaryComments()).find((comment) =>
    comment.body.includes(SUMMARY_MARKER),
  );
  if (summary === undefined) {
    await scm.createSummaryComment(body);
  } else if (summary.body !== body) {
    await scm.updateSummaryComment(summary.id, body);
  }
}

function statusDescription(input: SummaryInput): string {
  if (input.gate.threshold === "none") {
    return `advisory: ${String(input.findings.length)} finding(s)`;
  }
  if (input.gate.failed) {
    return `${String(input.gate.failing)} finding(s) at or above ${input.gate.threshold}`;
  }
  return `passed at failOn=${input.gate.threshold}`;
}

/**
 * Idempotent publication: comments carry a fingerprint marker, so re-runs
 * update what changed, delete what resolved, and never duplicate.
 */
export async function publishReview(
  scm: ScmPort,
  input: SummaryInput & { commitStatus: boolean },
): Promise<PublishOutcome> {
  const outcome: PublishOutcome = { created: 0, updated: 0, deleted: 0, unchanged: 0 };
  await reconcileInlineComments(scm, input.findings, outcome);
  await upsertSummary(scm, renderSummaryBody(input));
  if (input.commitStatus) {
    const state: StatusState = input.gate.failed ? "failure" : "success";
    await scm.postStatus(state, statusDescription(input));
  }
  return outcome;
}
