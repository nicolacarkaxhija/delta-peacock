import { createHash } from "node:crypto";
import type { Config } from "../config/schema.js";
import { fingerprintFrom, fingerprintOf, type Finding } from "../domain/finding.js";
import {
  blockedLine,
  DEFAULT_PRESENTATION,
  guidelineUrl,
  headingAnchor,
  markerFingerprint,
  renderCommentBody,
  isSummaryBody,
  renderSummaryBody,
  severityWord,
  stateLine,
  statusLine,
  SUMMARY_MARKER,
  twoSentences,
  type Presentation,
  type SummaryInput,
} from "./comment-format.js";
import type { InsightReport, ScmComment, ScmPort, ScmTask, StatusState } from "./port.js";

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
  /** Present only when tasks are on. */
  tasksCreated?: number;
  tasksResolved?: number;
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
    result: statusState(input) === "failure" ? "FAILED" : "PASSED",
    details: blocked === undefined ? stateLine(input) : `${stateLine(input)}. ${blocked}.`,
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
        ...(finding.unplaced === true ? {} : { line: finding.line }),
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

/**
 * The unclaimed fingerprint a comment stands for. A marker names it exactly;
 * a heading, path and line name only the base, so findings sharing all three
 * take a free suffix: the one whose body matches, or unless exactOnly the first.
 */
function claimFingerprint(
  comment: ScmComment,
  presentation: Presentation,
  desired: ReadonlyMap<string, Finding>,
  taken: ReadonlySet<string>,
  exactOnly: boolean,
): string | undefined {
  const marked = markerFingerprint(comment.body);
  if (marked !== undefined || presentation.markers) {
    return marked === undefined || taken.has(marked) ? undefined : marked;
  }
  const anchor = headingAnchor(comment.body);
  if (anchor === undefined || comment.path === undefined || comment.line === undefined) {
    return undefined;
  }
  const base = fingerprintFrom(comment.path, anchor, comment.line);
  const free: { fingerprint: string; finding: Finding }[] = [];
  for (let index = 0; ; index += 1) {
    const fingerprint = index === 0 ? base : `${base}-${String(index)}`;
    const finding = desired.get(fingerprint);
    if (finding === undefined) break;
    if (!taken.has(fingerprint)) free.push({ fingerprint, finding });
  }
  const same = free.find(
    ({ fingerprint, finding }) =>
      renderCommentBody(finding, fingerprint, presentation) === comment.body,
  );
  return (same ?? (exactOnly ? undefined : free[0]))?.fingerprint;
}

/** Exact body matches claim first, so a reorder or a dropped twin rewrites nothing. */
function assignFingerprints(
  existing: readonly ScmComment[],
  presentation: Presentation,
  desired: ReadonlyMap<string, Finding>,
): Map<ScmComment, string> {
  const claims = new Map<ScmComment, string>();
  const taken = new Set<string>();
  for (const exactOnly of [true, false]) {
    for (const comment of existing) {
      if (claims.has(comment)) continue;
      const fingerprint = claimFingerprint(comment, presentation, desired, taken, exactOnly);
      if (fingerprint === undefined) continue;
      claims.set(comment, fingerprint);
      taken.add(fingerprint);
    }
  }
  return claims;
}

/** A thread with replies is resolved where the host can, so the discussion keeps its context. */
async function retireComment(scm: ScmPort, comment: ScmComment): Promise<void> {
  if ((comment.replies ?? 0) > 0 && scm.resolveComment !== undefined) {
    await scm.resolveComment(comment.id);
  } else {
    await scm.deleteComment(comment.id);
  }
}

function looksLikeFinding(comment: ScmComment, presentation: Presentation): boolean {
  return (
    markerFingerprint(comment.body) !== undefined ||
    (!presentation.markers && headingAnchor(comment.body) !== undefined)
  );
}

/** Returns the comment id each posted finding lives in, where the host names one. */
async function reconcileInlineComments(
  scm: ScmPort,
  presentation: Presentation,
  desired: ReadonlyMap<string, Finding>,
  outcome: PublishOutcome,
  settled: ReadonlySet<string> = new Set(),
): Promise<Map<string, string>> {
  const commentIds = new Map<string, string>();
  const existing = await ownComments(
    scm,
    presentation,
    (await scm.listInlineComments()).filter((comment) => looksLikeFinding(comment, presentation)),
  );
  const claims = assignFingerprints(existing, presentation, desired);
  const seen = new Set<string>();
  for (const comment of existing) {
    const fingerprint = claims.get(comment);
    const finding = fingerprint === undefined ? undefined : desired.get(fingerprint);
    if (comment.resolved === true || (fingerprint !== undefined && settled.has(fingerprint))) {
      // a resolved thread or task is the team's call: left as is, and its finding is not reposted
      if (fingerprint !== undefined && finding !== undefined) {
        seen.add(fingerprint);
        outcome.unchanged += 1;
      }
      continue;
    }
    if (fingerprint === undefined || finding === undefined) {
      await retireComment(scm, comment);
      outcome.deleted += 1;
      continue;
    }
    seen.add(fingerprint);
    commentIds.set(fingerprint, comment.id);
    const body = renderCommentBody(finding, fingerprint, presentation);
    if (body === comment.body) {
      outcome.unchanged += 1;
    } else {
      await scm.updateComment(comment.id, body);
      outcome.updated += 1;
    }
  }
  for (const [fingerprint, finding] of desired) {
    if (seen.has(fingerprint) || settled.has(fingerprint)) continue;
    const id = await scm.createInlineComment({
      body: renderCommentBody(finding, fingerprint, presentation),
      path: finding.file,
      line: finding.line,
    });
    if (typeof id === "string") commentIds.set(fingerprint, id);
    outcome.created += 1;
  }
  return commentIds;
}

/** Short stable digest of a line's text, so a later run can tell whether it changed. */
export function lineDigest(text: string | undefined): string {
  return createHash("sha256")
    .update((text ?? "").trim())
    .digest("hex")
    .slice(0, 8);
}

const TASK_REF = /\bref ([0-9a-f]+(?:-\d+)?)\.([0-9a-f]{8})$/;

/** One line a person reads, ending in the reference a later run matches on. */
export function taskContent(finding: Finding, fingerprint: string, digest: string): string {
  const cite = finding.kind === "violation" ? finding.guidelineId : "observation";
  return `${severityWord(finding.severity)}: ${cite} in ${finding.file} line ${String(finding.line)}, ref ${fingerprint}.${digest}`;
}

interface OwnTask {
  task: ScmTask;
  fingerprint: string;
  digest: string;
  file: string;
  line: number;
}

function ownTask(task: ScmTask): OwnTask | undefined {
  const ref = TASK_REF.exec(task.content);
  const where = / in (.+) line (\d+), ref /.exec(task.content);
  if (ref === null || where === null) return undefined;
  return {
    task,
    fingerprint: String(ref[1]),
    digest: String(ref[2]),
    file: String(where[1]),
    line: Number(where[2]),
  };
}

export interface TaskOutcome {
  tasksCreated: number;
  tasksResolved: number;
}

/**
 * Tasks mirror findings: one per posted finding, resolved by the reviewer once
 * the anchored line changed, left open while it stands. A finding whose task a
 * person resolved stays settled and is not posted again.
 */
interface TaskApi {
  list(): Promise<ScmTask[]>;
  create(content: string, commentId: string): Promise<void>;
  resolve(id: string): Promise<void>;
}

function taskApiOf(scm: ScmPort): TaskApi | undefined {
  if (
    scm.listTasks === undefined ||
    scm.createTask === undefined ||
    scm.resolveTask === undefined
  ) {
    return undefined;
  }
  const port = scm as ScmPort & Required<Pick<ScmPort, "listTasks" | "createTask" | "resolveTask">>;
  return {
    list: () => port.listTasks(),
    create: (content, commentId) => port.createTask(content, commentId),
    resolve: (id) => port.resolveTask(id),
  };
}

async function reconcileTasks(
  scm: TaskApi,
  own: readonly OwnTask[],
  desired: ReadonlyMap<string, Finding>,
  commentIds: ReadonlyMap<string, string>,
  lineTextOf: (file: string, line: number) => string | undefined,
  outcome: PublishOutcome,
): Promise<void> {
  for (const entry of own) {
    if (entry.task.resolved) continue;
    if (lineDigest(lineTextOf(entry.file, entry.line)) === entry.digest) continue;
    await scm.resolve(entry.task.id);
    outcome.tasksResolved = (outcome.tasksResolved ?? 0) + 1;
  }
  for (const [fingerprint, finding] of desired) {
    const commentId = commentIds.get(fingerprint);
    if (commentId === undefined) continue;
    const digest = lineDigest(lineTextOf(finding.file, finding.line));
    if (own.some((entry) => entry.fingerprint === fingerprint && entry.digest === digest)) continue;
    await scm.create(taskContent(finding, fingerprint, digest), commentId);
    outcome.tasksCreated = (outcome.tasksCreated ?? 0) + 1;
  }
}

async function upsertSummary(
  scm: ScmPort,
  presentation: Presentation,
  body: string,
  createIfMissing: boolean,
): Promise<void> {
  // the marker also finds a pre 0.1.5 summary, so an upgrade replaces it in place
  const candidates = (await scm.listSummaryComments()).filter(
    (comment) =>
      comment.body.trimEnd().split("\n").at(-1) === SUMMARY_MARKER ||
      (!presentation.markers && isSummaryBody(comment.body, presentation)),
  );
  const [summary, ...extra] = await ownComments(scm, presentation, candidates);
  if (summary === undefined) {
    if (createIfMissing) await scm.createSummaryComment(body);
    return;
  }
  if (summary.body !== body) await scm.updateSummaryComment(summary.id, body);
  for (const duplicate of extra) await scm.deleteComment(duplicate.id);
}

/** A capped run fails the status only where the gate would have blocked. */
function statusState(input: SummaryInput): StatusState {
  const kind = input.outcome?.kind;
  if (kind === "failed") return "failure";
  if (kind === "capped") return input.gate.threshold === "none" ? "success" : "failure";
  return input.gate.failed ? "failure" : "success";
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
    /** Post a summary comment on a clean run even where an Insights card carries the result. */
    summaryWhenClean?: boolean;
    presentation?: PresentationSettings;
    /** One pull request task per posted finding, where the host has tasks. */
    tasks?: boolean;
    /** A file's line at the reviewed commit; tasks resolve once it changed. */
    lineTextOf?: (file: string, line: number) => string | undefined;
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
  const failed = input.outcome?.kind === "failed" || input.outcome?.kind === "capped";
  if (input.comments !== false) {
    // a broken run knows nothing about the code, so earlier inline comments stay as they are
    if (!failed) {
      const placed = input.findings.filter((finding) => finding.unplaced !== true);
      const desired = new Map(
        fingerprintEntries(placed).map(({ fingerprint, finding }) => [fingerprint, finding]),
      );
      const taskApi = input.tasks === true ? taskApiOf(scm) : undefined;
      if (input.tasks === true && taskApi === undefined) {
        outcome.notices.push("this provider has no pull request tasks; skipping them");
      }
      let own: OwnTask[] = [];
      const settled = new Set<string>();
      if (taskApi !== undefined) {
        own = (await taskApi.list()).flatMap((task) => {
          const parsed = ownTask(task);
          return parsed === undefined ? [] : [parsed];
        });
        const me = await scm.currentUserId?.();
        // a person settled it; the reviewer does not raise it again
        for (const entry of own) {
          if (entry.task.resolved && entry.task.resolvedBy !== me) settled.add(entry.fingerprint);
        }
      }
      const commentIds = await reconcileInlineComments(
        scm,
        presentation,
        desired,
        outcome,
        settled,
      );
      if (taskApi !== undefined) {
        await reconcileTasks(
          taskApi,
          own,
          desired,
          commentIds,
          input.lineTextOf ?? (() => undefined),
          outcome,
        );
      }
    }
    // where an Insights card carries a clean result, a clean summary only updates an earlier one
    const cardCarries = input.codeInsights === true && scm.publishInsights !== undefined;
    const quiet =
      input.findings.length === 0 && !failed && cardCarries && input.summaryWhenClean !== true;
    await upsertSummary(scm, presentation, renderSummaryBody(input, presentation), !quiet);
  }
  if (input.commitStatus) {
    await scm.postStatus(statusState(input), statusLine(input), presentation.displayName);
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
