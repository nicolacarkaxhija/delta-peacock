import { createHash } from "node:crypto";
import type { Config } from "../config/schema.js";
import { fingerprintFrom, fingerprintOf, type Finding } from "../domain/finding.js";
import {
  blockedLine,
  DEFAULT_PRESENTATION,
  guidelineLine,
  guidelineUrl,
  headingAnchor,
  linkedHeading,
  linkTickets,
  markerFingerprint,
  renderCommentBody,
  isSummaryBody,
  renderSummaryBody,
  severityCounts,
  severityWord,
  stateLine,
  statusLine,
  SUMMARY_MARKER,
  twoSentences,
  type Presentation,
  type SummaryInput,
  type TicketLinks,
} from "./comment-format.js";
import type { InsightReport, ScmComment, ScmPort, ScmTask, StatusState } from "./port.js";

export { renderCommentBody, renderSummaryBody, type SummaryInput } from "./comment-format.js";

/** A guideline's file in the repository and the commit it was read from. */
export interface GuidelineSource {
  path: string;
  commit: string;
}

/** What the configuration contributes to a presentation; the host adds the rest. */
export interface PresentationSettings {
  displayName: string;
  guidelinesDir: string;
  /** Branch the docs link, and guideline links when their files are unknown, point at. */
  targetBranch: string;
  /** Repository doc on how reviews work; absent when the file does not exist. */
  guidePath?: string;
  /** False when the doc exists only on the reviewed branch, so it is named without a link. */
  guideLinked?: boolean;
  /** Each local guideline's file; an id missing here gets no link. */
  guidelineFiles?: ReadonlyMap<string, GuidelineSource>;
  /** Ticket address with {key} for the key, and the key's pattern; absent leaves keys plain. */
  tickets?: { url: string; pattern: string };
}

/** The ticket address with the key put in place of every {key}. */
function ticketLinks(tickets: { url: string; pattern: string }): TicketLinks {
  return {
    pattern: tickets.pattern,
    link: (key) => tickets.url.replaceAll("{key}", encodeURIComponent(key)),
  };
}

/** Combines the settings with what the host can render; commentOf names a finding's comment. */
export function presentationFor(
  scm: ScmPort,
  settings: PresentationSettings | undefined,
  reviewedCommit: string | undefined,
  commentOf: (finding: Finding) => string | undefined,
): Presentation {
  const base = settings ?? {
    displayName: DEFAULT_PRESENTATION.displayName,
    guidelinesDir: DEFAULT_PRESENTATION.guidelinesDir,
    targetBranch: "main",
  };
  const fileUrl = scm.fileUrl?.bind(scm);
  const commitUrl = scm.commitUrl?.bind(scm);
  const commentUrl = scm.commentUrl?.bind(scm);
  const files = base.guidelineFiles;
  const atReviewed =
    fileUrl === undefined || reviewedCommit === undefined
      ? undefined
      : (file: string, line?: number) => fileUrl(file, reviewedCommit, line);
  return {
    displayName: base.displayName,
    markers: scm.hidesHtmlComments !== false,
    suggestionFence: scm.suggestionFence ?? "suggestion",
    guidelinesDir: base.guidelinesDir,
    ...(fileUrl !== undefined
      ? {
          fileLink: (file: string) => fileUrl(file, base.targetBranch),
          ...(files !== undefined
            ? {
                guidelineLink: (id: string) => {
                  const source = files.get(id);
                  return source === undefined ? undefined : fileUrl(source.path, source.commit);
                },
              }
            : {}),
        }
      : {}),
    placeLink: (finding: Finding) => {
      const commentId = commentOf(finding);
      if (commentId !== undefined && commentUrl !== undefined) return commentUrl(commentId);
      return atReviewed?.(finding.file, finding.unplaced === true ? undefined : finding.line);
    },
    ...(atReviewed !== undefined ? { reviewedFileLink: (file: string) => atReviewed(file) } : {}),
    ...(commitUrl !== undefined ? { commitLink: commitUrl } : {}),
    ...(base.guidePath !== undefined ? { guidePath: base.guidePath } : {}),
    ...(base.guideLinked !== undefined ? { guideLinked: base.guideLinked } : {}),
    ...(scm.severityScale !== undefined ? { severityScale: scm.severityScale } : {}),
    ...(base.tickets !== undefined ? { tickets: ticketLinks(base.tickets) } : {}),
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

/** Code Insights caps a summary at 450 characters; the reason is cut before the guideline line. */
const ANNOTATION_MAX = 450;

function annotationSummary(finding: Finding): string {
  const reason = twoSentences(finding.body === "" ? finding.title : finding.body);
  const rule = guidelineLine(finding);
  if (rule === undefined) return reason.slice(0, ANNOTATION_MAX);
  const room = ANNOTATION_MAX - rule.length - 1;
  if (room < 1) return rule.slice(0, ANNOTATION_MAX);
  return `${reason.slice(0, room)} ${rule}`;
}

const INSIGHT_RESULTS: Readonly<Record<StatusState, InsightReport["result"]>> = {
  success: "PASSED",
  failure: "FAILED",
  pending: "PENDING",
};

export function buildInsightReport(
  input: SummaryInput,
  presentation: Presentation = DEFAULT_PRESENTATION,
): InsightReport {
  const blocked = blockedLine(input, presentation);
  const state = stateLine(input, presentation);
  return {
    title: presentation.displayName,
    result: INSIGHT_RESULTS[statusState(input)],
    details: blocked === undefined ? state : `${state}. ${blocked}.`,
    counts: [
      { label: "Findings", value: input.findings.length },
      ...severityCounts(input.findings, presentation).map(([word, value]) => ({
        label: `${word.charAt(0).toUpperCase()}${word.slice(1)}`,
        value,
      })),
    ],
    annotations: fingerprintEntries(input.findings).map(({ fingerprint, finding }) => {
      const link =
        finding.kind === "violation" && finding.pack === undefined
          ? guidelineUrl(finding.guidelineId, presentation)
          : undefined;
      return {
        externalId: fingerprint,
        title: finding.title,
        summary: annotationSummary(finding),
        severity: finding.severity,
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
  const same = free.find(({ fingerprint, finding }) =>
    sameComment(renderCommentBody(finding, fingerprint, presentation), comment.body),
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

/** Starts the line that turns a finding's comment into the trace of its resolution. */
export const RESOLVED_PREFIX = "Resolved in ";

/** A comment the reviewer already turned into a resolution trace. */
export function isResolvedTrace(body: string): boolean {
  return body.split("\n").some((line) => line.startsWith(RESOLVED_PREFIX));
}

/** Twelve hex digits of a commit hash: unique in any repository this size, short enough for a line. */
const SHORT_HASH_LENGTH = 12;

/** A commit as readers see it: the short hash, linked where the host can. */
function commitText(sha: string, presentation: Pick<Presentation, "commitLink">): string {
  const short = sha.slice(0, SHORT_HASH_LENGTH);
  const url = presentation.commitLink?.(sha);
  return url === undefined ? `\`${short}\`` : `[${short}](${url})`;
}

/** The finding's heading kept and linked, the rest replaced by where it was resolved. */
export function resolvedBody(
  body: string,
  reviewedCommit: string | undefined,
  presentation: Presentation = DEFAULT_PRESENTATION,
): string {
  const heading = linkedHeading(String(body.split("\n")[0]), presentation);
  const where =
    reviewedCommit !== undefined ? commitText(reviewedCommit, presentation) : "a later commit";
  return linkTickets(
    `${heading}\n\n${RESOLVED_PREFIX}${where}: the flagged line changed or the finding no longer holds.`,
    presentation,
  );
}

const TRACE_HASH = /^Resolved in `([0-9a-f]{7,40})`:/;

/** A trace an earlier version wrote, with its heading and commit linked; unchanged when nothing links. */
export function linkedTrace(body: string, presentation: Presentation): string {
  const [heading = "", ...rest] = body.split("\n");
  const lines = rest.map((line) => {
    const sha = TRACE_HASH.exec(line)?.[1];
    if (sha === undefined || presentation.commitLink === undefined) return line;
    return `${RESOLVED_PREFIX}${commitText(sha, presentation)}:${line.slice(line.indexOf("`:") + 2)}`;
  });
  return linkTickets([linkedHeading(heading, presentation), ...lines].join("\n"), presentation);
}

const LINK_TARGET = /\]\([^)\s]*\)/g;

/** Equal up to the commits their links point at, so a new commit alone rewrites nothing. */
export function sameComment(rendered: string, posted: string): boolean {
  const withoutCommits = (body: string) =>
    body.replace(LINK_TARGET, (target) => target.replace(/\b[0-9a-f]{40}\b/g, "{commit}"));
  return rendered === posted || withoutCommits(rendered) === withoutCommits(posted);
}

/** An error that says the thing is already gone, which is what cleanup wanted. */
function isGone(error: unknown): boolean {
  return error instanceof Error && /\b(?:404|410)\b/.test(error.message);
}

/**
 * Cleanup that must never fail a review: a gone target counts as done, any
 * other error becomes a notice and the run goes on to its summary and status.
 */
async function cleanup(
  outcome: PublishOutcome,
  what: string,
  action: () => Promise<void>,
): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (error) {
    if (isGone(error)) return false;
    outcome.notices.push(
      `could not ${what} (${(error as Error).message.split("\n")[0] ?? ""}); continuing`,
    );
    return false;
  }
}

/**
 * A finding that no longer holds leaves a trace a reader can follow: its
 * comment is rewritten to say where it was resolved and the thread resolved
 * where the host can, instead of vanishing with the task attached to it.
 */
async function retireComment(
  scm: ScmPort,
  comment: ScmComment,
  reviewedCommit: string | undefined,
  presentation: Presentation,
  outcome: PublishOutcome,
): Promise<void> {
  const edited = await cleanup(outcome, `mark comment ${comment.id} resolved`, () =>
    scm.updateComment(comment.id, resolvedBody(comment.body, reviewedCommit, presentation)),
  );
  if (edited) outcome.deleted += 1;
  if (edited && scm.resolveComment !== undefined) {
    const resolve = scm.resolveComment.bind(scm);
    await cleanup(outcome, `resolve the thread of comment ${comment.id}`, () =>
      resolve(comment.id),
    );
  }
}

/** An earlier comment a fallback run left as it is, named in the summary. */
interface KeptComment {
  label: string;
  commentId: string;
}

function looksLikeFinding(comment: ScmComment, presentation: Presentation): boolean {
  if (isResolvedTrace(comment.body)) return false;
  return (
    markerFingerprint(comment.body) !== undefined ||
    (!presentation.markers && headingAnchor(comment.body) !== undefined)
  );
}

/**
 * Returns the comment id each open finding lives in, for its task, and each
 * finding's comment even on a resolved thread, for the summary's links.
 */
async function reconcileInlineComments(
  scm: ScmPort,
  presentation: Presentation,
  desired: ReadonlyMap<string, Finding>,
  outcome: PublishOutcome,
  settled: ReadonlySet<string> = new Set(),
  reviewedCommit?: string,
  notRejudged?: KeptComment[],
): Promise<{ commentIds: Map<string, string>; anchors: Map<string, string> }> {
  const commentIds = new Map<string, string>();
  const anchors = new Map<string, string>();
  const listed = await scm.listInlineComments();
  // a trace an earlier version wrote gains its links once
  const oldTraces = listed.filter(
    (comment) =>
      isResolvedTrace(comment.body) &&
      headingAnchor(comment.body) !== undefined &&
      !sameComment(linkedTrace(comment.body, presentation), comment.body),
  );
  const own = await ownComments(scm, presentation, [
    ...listed.filter((comment) => looksLikeFinding(comment, presentation)),
    ...oldTraces,
  ]);
  for (const trace of own.filter((comment) => oldTraces.includes(comment))) {
    const edited = await cleanup(outcome, `link the trace in comment ${trace.id}`, () =>
      scm.updateComment(trace.id, linkedTrace(trace.body, presentation)),
    );
    if (edited) outcome.updated += 1;
  }
  const existing = own.filter((comment) => !oldTraces.includes(comment));
  const claims = assignFingerprints(existing, presentation, desired);
  const seen = new Set<string>();
  for (const comment of existing) {
    const fingerprint = claims.get(comment);
    const finding = fingerprint === undefined ? undefined : desired.get(fingerprint);
    if (comment.resolved === true || (fingerprint !== undefined && settled.has(fingerprint))) {
      // a resolved thread or task is the team's call: left as is, and its finding is not reposted
      if (fingerprint !== undefined && finding !== undefined) {
        seen.add(fingerprint);
        anchors.set(fingerprint, comment.id);
        outcome.unchanged += 1;
      }
      continue;
    }
    if (fingerprint === undefined || finding === undefined) {
      if (notRejudged !== undefined) {
        // a fallback run cannot tell whether a model's finding still holds
        const where = comment.line !== undefined ? `:${String(comment.line)}` : "";
        notRejudged.push({
          label: comment.path !== undefined ? `${comment.path}${where}` : `comment ${comment.id}`,
          commentId: comment.id,
        });
        outcome.unchanged += 1;
      } else {
        await retireComment(scm, comment, reviewedCommit, presentation, outcome);
      }
      continue;
    }
    seen.add(fingerprint);
    commentIds.set(fingerprint, comment.id);
    anchors.set(fingerprint, comment.id);
    const body = renderCommentBody(finding, fingerprint, presentation);
    if (sameComment(body, comment.body) || notRejudged !== undefined) {
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
    if (typeof id === "string") {
      commentIds.set(fingerprint, id);
      anchors.set(fingerprint, id);
    }
    outcome.created += 1;
  }
  return { commentIds, anchors };
}

/** Short stable digest of a line's text, so a later run can tell whether it changed. */
export function lineDigest(text: string | undefined): string {
  return createHash("sha256")
    .update((text ?? "").trim())
    .digest("hex")
    .slice(0, 8);
}

const TASK_REF = /\bref ([0-9a-f]+(?:-\d+)?)\.([0-9a-f]{8})$/;

/** One line a person reads, ending in the reference a later run matches on; Bitbucket renders its links. */
export function taskContent(
  finding: Finding,
  fingerprint: string,
  digest: string,
  presentation: Presentation = DEFAULT_PRESENTATION,
): string {
  const id = finding.kind === "violation" ? finding.guidelineId : "observation";
  const guideline =
    finding.kind === "violation" && finding.pack === undefined
      ? guidelineUrl(id, presentation)
      : undefined;
  const cite = guideline === undefined ? id : `[${id}](${guideline})`;
  const where = `${finding.file} line ${String(finding.line)}`;
  const place = presentation.placeLink?.(finding);
  const at = place === undefined ? where : `[${where}](${place})`;
  return `${severityWord(finding.severity, presentation)}: ${cite} in ${at}, ref ${fingerprint}.${digest}`;
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
  // a linked place, or the plain one earlier versions wrote
  const where = / in (?:\[(.+) line (\d+)\]\([^)\s]*\)|(.+) line (\d+)), ref /.exec(task.content);
  if (ref === null || where === null) return undefined;
  return {
    task,
    fingerprint: String(ref[1]),
    digest: String(ref[2]),
    file: String(where[1] ?? where[3]),
    line: Number(where[2] ?? where[4]),
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

/**
 * Resolves the open tasks whose finding is gone or whose line changed. Runs
 * before any comment changes: on Bitbucket a task lives on its comment.
 */
async function resolveStaleTasks(
  scm: TaskApi,
  own: readonly OwnTask[],
  desired: ReadonlyMap<string, Finding>,
  lineTextOf: (file: string, line: number) => string | undefined,
  outcome: PublishOutcome,
): Promise<void> {
  for (const entry of own) {
    if (entry.task.resolved) continue;
    const stands =
      desired.has(entry.fingerprint) &&
      lineDigest(lineTextOf(entry.file, entry.line)) === entry.digest;
    if (stands) continue;
    const done = await cleanup(outcome, `resolve task ${entry.task.id}`, () =>
      scm.resolve(entry.task.id),
    );
    if (done) outcome.tasksResolved = (outcome.tasksResolved ?? 0) + 1;
  }
}

async function createTasks(
  scm: TaskApi,
  own: readonly OwnTask[],
  desired: ReadonlyMap<string, Finding>,
  commentIds: ReadonlyMap<string, string>,
  lineTextOf: (file: string, line: number) => string | undefined,
  outcome: PublishOutcome,
  presentation: Presentation,
): Promise<void> {
  for (const [fingerprint, finding] of desired) {
    const commentId = commentIds.get(fingerprint);
    if (commentId === undefined) continue;
    const digest = lineDigest(lineTextOf(finding.file, finding.line));
    if (own.some((entry) => entry.fingerprint === fingerprint && entry.digest === digest)) continue;
    await scm.create(taskContent(finding, fingerprint, digest, presentation), commentId);
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
  if (input.gate.failed) return "failure";
  // fallback.status pending keeps a fallback from reading as a pass
  return input.factsOnly?.fallback !== undefined && input.factsOnly.fallbackStatus === "pending"
    ? "pending"
    : "success";
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
    /** The reviewed commit, full hash: named on the comment of a finding it resolved, and where file links point. */
    reviewedCommit?: string;
    /** The hard guarantee (spec: "a single dry-run switch gates every outbound write"): true short-circuits before any adapter call, even one a caller forgot to gate itself. */
    dryRun: boolean;
  },
): Promise<PublishOutcome> {
  const outcome: PublishOutcome = { created: 0, updated: 0, deleted: 0, unchanged: 0, notices: [] };
  if (input.dryRun) {
    outcome.notices.push("dry run: no comments, summary or status will be posted");
    return outcome;
  }
  // filled as comments are reconciled, read when the summary renders
  const commentOf = new Map<Finding, string>();
  const presentation = presentationFor(scm, input.presentation, input.reviewedCommit, (finding) =>
    commentOf.get(finding),
  );
  const failed = input.outcome?.kind === "failed" || input.outcome?.kind === "capped";
  // a fallback leaves what an earlier model run posted as it is, and lists it in the summary
  const notRejudged: KeptComment[] | undefined =
    input.factsOnly?.fallback !== undefined ? [] : undefined;
  let summaryInput: SummaryInput = input;
  if (input.comments !== false) {
    // a broken run knows nothing about the code, so earlier inline comments stay as they are
    if (!failed) {
      const placed = input.findings.filter((finding) => finding.unplaced !== true);
      const desired = new Map(
        fingerprintEntries(placed).map(({ fingerprint, finding }) => [fingerprint, finding]),
      );
      const taskApi = input.tasks === true ? taskApiOf(scm) : undefined;
      const lineTextOf = input.lineTextOf ?? (() => undefined);
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
        if (notRejudged === undefined) {
          await resolveStaleTasks(taskApi, own, desired, lineTextOf, outcome);
        }
      }
      const { commentIds, anchors } = await reconcileInlineComments(
        scm,
        presentation,
        desired,
        outcome,
        settled,
        input.reviewedCommit,
        notRejudged,
      );
      for (const [fingerprint, id] of anchors) {
        const finding = desired.get(fingerprint);
        if (finding !== undefined) commentOf.set(finding, id);
      }
      if (taskApi !== undefined) {
        await createTasks(taskApi, own, desired, commentIds, lineTextOf, outcome, presentation);
      }
      if (input.factsOnly !== undefined && notRejudged !== undefined && notRejudged.length > 0) {
        notRejudged.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
        const named = notRejudged.map(({ label, commentId }) => {
          const url = scm.commentUrl?.(commentId);
          return url === undefined ? label : `[${label}](${url})`;
        });
        summaryInput = { ...input, factsOnly: { ...input.factsOnly, notRejudged: named } };
      }
    }
    // a clean card carries a clean result, but never a facts only one, which must say so
    const cardCarries = input.codeInsights === true && scm.publishInsights !== undefined;
    const quiet =
      input.findings.length === 0 &&
      !failed &&
      cardCarries &&
      input.summaryWhenClean !== true &&
      input.factsOnly === undefined;
    await upsertSummary(scm, presentation, renderSummaryBody(summaryInput, presentation), !quiet);
  }
  if (input.commitStatus) {
    await scm.postStatus(
      statusState(input),
      statusLine(input, presentation),
      presentation.displayName,
    );
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
