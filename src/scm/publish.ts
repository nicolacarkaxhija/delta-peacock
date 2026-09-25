import type { Config } from "../config/schema.js";
import { fingerprintFrom, fingerprintOf, type Finding } from "../domain/finding.js";
import {
  blockedLine,
  countLine,
  DEFAULT_PRESENTATION,
  guidelineUrl,
  headingAnchor,
  markerFingerprint,
  renderCommentBody,
  renderSummaryBody,
  summaryHeading,
  SUMMARY_MARKER,
  twoSentences,
  type Presentation,
  type SummaryInput,
} from "./comment-format.js";
import type { InsightReport, ScmComment, ScmPort, StatusState } from "./port.js";

export { renderCommentBody, renderSummaryBody, type SummaryInput } from "./comment-format.js";

/** What the configuration contributes to a presentation; the host adds the rest. */
export interface PresentationSettings {
  displayName: string;
  guidelinesDir: string;
  /** Branch guideline and docs links point at. */
  targetBranch: string;
  /** Repository doc on how reviews work; absent when the file does not exist. */
  guidePath?: string;
}

/** Combines the settings with what the host can render. */
export function presentationFor(scm: ScmPort, settings?: PresentationSettings): Presentation {
  const base = settings ?? {
    displayName: DEFAULT_PRESENTATION.displayName,
    guidelinesDir: DEFAULT_PRESENTATION.guidelinesDir,
    targetBranch: "main",
  };
  const fileUrl = scm.fileUrl?.bind(scm);
  return {
    displayName: base.displayName,
    markers: scm.hidesHtmlComments !== false,
    suggestionFence: scm.suggestionFence ?? "suggestion",
    guidelinesDir: base.guidelinesDir,
    ...(fileUrl !== undefined
      ? { fileLink: (file: string) => fileUrl(file, base.targetBranch) }
      : {}),
    ...(base.guidePath !== undefined ? { guidePath: base.guidePath } : {}),
  };
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

export interface PublishOutcome {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  notices: string[];
}

/** Bitbucket's four annotation severities absorb the five review severities. */
const INSIGHT_SEVERITIES: Record<
  "BLOCKER" | "CRITICAL" | "MAJOR" | "MINOR" | "INFO",
  "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"
> = {
  BLOCKER: "CRITICAL",
  CRITICAL: "HIGH",
  MAJOR: "MEDIUM",
  MINOR: "LOW",
  INFO: "LOW",
};

export function buildInsightReport(
  input: SummaryInput,
  presentation: Presentation = DEFAULT_PRESENTATION,
): InsightReport {
  const counts = new Map<string, number>();
  for (const finding of input.findings) {
    counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  }
  const blocked = blockedLine(input);
  return {
    title: presentation.displayName,
    result: input.gate.failed ? "FAILED" : "PASSED",
    details:
      blocked === undefined
        ? countLine(input.findings)
        : `${countLine(input.findings)}. ${blocked}.`,
    counts: [
      { label: "Findings", value: input.findings.length },
      ...(["BLOCKER", "CRITICAL", "MAJOR", "MINOR", "INFO"] as const).flatMap((severity) => {
        const value = counts.get(severity);
        return value === undefined
          ? []
          : [{ label: `${severity.charAt(0)}${severity.slice(1).toLowerCase()}`, value }];
      }),
    ],
    annotations: fingerprintEntries(input.findings).map(({ fingerprint, finding }) => {
      const link =
        finding.kind === "violation" && finding.pack === undefined
          ? guidelineUrl(finding.guidelineId, presentation)
          : undefined;
      return {
        externalId: fingerprint,
        title: finding.title,
        summary: twoSentences(finding.body === "" ? finding.title : finding.body).slice(0, 450),
        severity: INSIGHT_SEVERITIES[finding.severity],
        path: finding.file,
        line: finding.line,
        ...(link !== undefined ? { link } : {}),
      };
    }),
  };
}

/**
 * The reviewer's own comments among candidates that look like its output. On
 * a host that prints markers the look is the identity; elsewhere the author
 * must also be the token's user, asked only when a candidate exists.
 */
async function ownComments(
  scm: ScmPort,
  presentation: Presentation,
  candidates: ScmComment[],
): Promise<ScmComment[]> {
  if (presentation.markers || candidates.length === 0 || scm.currentUserId === undefined) {
    return candidates;
  }
  const self = await scm.currentUserId();
  return candidates.filter((comment) => comment.authorId === self);
}

/** A comment's fingerprint: its marker, or on marker-less hosts its heading, path and line. */
function commentFingerprint(comment: ScmComment, presentation: Presentation): string | undefined {
  const marked = markerFingerprint(comment.body);
  if (marked !== undefined || presentation.markers) return marked;
  const anchor = headingAnchor(comment.body);
  if (anchor === undefined || comment.path === undefined || comment.line === undefined) {
    return undefined;
  }
  return fingerprintFrom(comment.path, anchor, comment.line);
}

function looksLikeFinding(comment: ScmComment, presentation: Presentation): boolean {
  return (
    markerFingerprint(comment.body) !== undefined ||
    (!presentation.markers && headingAnchor(comment.body) !== undefined)
  );
}

async function reconcileInlineComments(
  scm: ScmPort,
  presentation: Presentation,
  findings: readonly Finding[],
  outcome: PublishOutcome,
): Promise<void> {
  const desired = new Map(
    fingerprintEntries(findings).map(({ fingerprint, finding }) => [fingerprint, finding]),
  );
  const existing = await ownComments(
    scm,
    presentation,
    (await scm.listInlineComments()).filter((comment) => looksLikeFinding(comment, presentation)),
  );
  const seen = new Set<string>();
  for (const comment of existing) {
    const fingerprint = commentFingerprint(comment, presentation);
    const finding = fingerprint === undefined ? undefined : desired.get(fingerprint);
    if (fingerprint === undefined || finding === undefined || seen.has(fingerprint)) {
      await scm.deleteComment(comment.id);
      outcome.deleted += 1;
      continue;
    }
    seen.add(fingerprint);
    const body = renderCommentBody(finding, fingerprint, presentation);
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
      body: renderCommentBody(finding, fingerprint, presentation),
      path: finding.file,
      line: finding.line,
    });
    outcome.created += 1;
  }
}

async function upsertSummary(
  scm: ScmPort,
  presentation: Presentation,
  body: string,
): Promise<void> {
  const heading = summaryHeading(presentation);
  // the marker also finds a pre 0.1.5 summary, so an upgrade replaces it in place
  const candidates = (await scm.listSummaryComments()).filter(
    (comment) =>
      comment.body.trimEnd().split("\n").at(-1) === SUMMARY_MARKER ||
      (!presentation.markers && comment.body.split("\n")[0] === heading),
  );
  const [summary, ...extra] = await ownComments(scm, presentation, candidates);
  if (summary === undefined) {
    await scm.createSummaryComment(body);
    return;
  }
  if (summary.body !== body) await scm.updateSummaryComment(summary.id, body);
  for (const duplicate of extra) await scm.deleteComment(duplicate.id);
}

function statusDescription(input: SummaryInput): string {
  const blocked = blockedLine(input);
  if (blocked !== undefined) return blocked;
  return countLine(input.findings);
}

/** The one place every command asks whether a write is suppressed; nothing else reads config.scm.dryRun directly. */
export function isDryRun(config: Pick<Config, "scm">): boolean {
  return config.scm.dryRun;
}

/** Code Insights default on where the host has them (Bitbucket); an explicit setting wins. */
export function codeInsightsEnabled(config: Pick<Config, "scm">): boolean {
  return config.scm.codeInsights ?? config.scm.provider === "bitbucket";
}

/**
 * Idempotent publication: comments are recognised on re-runs (by marker, or
 * by author plus heading where markers would show), so re-runs update what
 * changed, delete what resolved, and never duplicate.
 */
export async function publishReview(
  scm: ScmPort,
  input: SummaryInput & {
    commitStatus: boolean;
    comments?: boolean;
    codeInsights?: boolean;
    presentation?: PresentationSettings;
    /** The hard guarantee (spec: "a single dry-run switch gates every outbound write"): true short-circuits before any adapter call, even one a caller forgot to gate itself. */
    dryRun: boolean;
  },
): Promise<PublishOutcome> {
  const outcome: PublishOutcome = { created: 0, updated: 0, deleted: 0, unchanged: 0, notices: [] };
  if (input.dryRun) {
    outcome.notices.push("dry run: no comments, summary or status will be posted");
    return outcome;
  }
  const presentation = presentationFor(scm, input.presentation);
  if (input.comments !== false) {
    await reconcileInlineComments(scm, presentation, input.findings, outcome);
    await upsertSummary(scm, presentation, renderSummaryBody(input, presentation));
  }
  if (input.commitStatus) {
    const state: StatusState = input.gate.failed ? "failure" : "success";
    await scm.postStatus(state, statusDescription(input), presentation.displayName);
  }
  if (input.codeInsights === true) {
    if (scm.publishInsights === undefined) {
      outcome.notices.push("this provider has no code insights; skipping them");
    } else {
      try {
        await scm.publishInsights(buildInsightReport(input, presentation));
      } catch (error) {
        // a workspace with insights disabled must not lose its review
        outcome.notices.push(
          `code insights rejected (${(error as Error).message.split("\n")[0] ?? ""}); continuing without them`,
        );
      }
    }
  }
  return outcome;
}
