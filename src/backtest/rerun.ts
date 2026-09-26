import type { Finding } from "../domain/finding.js";
import { evaluateGate } from "../domain/gate.js";
import type { ScmComment, ScmPort, ScmTask } from "../scm/port.js";
import { fingerprintEntries, publishReview, RESOLVED_PREFIX } from "../scm/publish.js";
import type { PriorFindingEntry as PriorFinding } from "./cases.js";

interface Call {
  op: "updateComment" | "deleteComment" | "resolveTask" | "resolveComment";
  id: string;
}

const SELF = "reviewer";

/**
 * An in-memory Bitbucket: html comments show, tasks hang on their comment and
 * go with it when it is deleted, and a gone task answers 404.
 */
export function memoryBitbucket(): ScmPort & {
  comments: ScmComment[];
  tasks: ScmTask[];
  calls: Call[];
} {
  const comments: ScmComment[] = [];
  const tasks: ScmTask[] = [];
  const calls: Call[] = [];
  let next = 1;
  const id = (): string => String(next++);
  return {
    comments,
    tasks,
    calls,
    hidesHtmlComments: false,
    suggestionFence: "",
    currentUserId: () => Promise.resolve(SELF),
    listInlineComments: () => Promise.resolve(comments.map((comment) => ({ ...comment }))),
    createInlineComment(comment) {
      const created = { id: id(), authorId: SELF, ...comment };
      comments.push(created);
      return Promise.resolve(created.id);
    },
    listTasks: () => Promise.resolve(tasks.map((task) => ({ ...task }))),
    createTask(content, commentId) {
      tasks.push({ id: id(), content, commentId, resolved: false });
      return Promise.resolve();
    },
    resolveTask(taskId) {
      calls.push({ op: "resolveTask", id: taskId });
      const task = tasks.find((one) => one.id === taskId);
      if (task === undefined) return Promise.reject(new Error(`404 task ${taskId}`));
      task.resolved = true;
      task.resolvedBy = SELF;
      return Promise.resolve();
    },
    updateComment(commentId, body) {
      calls.push({ op: "updateComment", id: commentId });
      const comment = comments.find((one) => one.id === commentId);
      if (comment === undefined) return Promise.reject(new Error(`404 comment ${commentId}`));
      comment.body = body;
      return Promise.resolve();
    },
    deleteComment(commentId) {
      calls.push({ op: "deleteComment", id: commentId });
      const at = comments.findIndex((one) => one.id === commentId);
      if (at >= 0) comments.splice(at, 1);
      for (let index = tasks.length - 1; index >= 0; index -= 1) {
        if (tasks[index]?.commentId === commentId) tasks.splice(index, 1);
      }
      return Promise.resolve();
    },
    resolveComment(commentId) {
      calls.push({ op: "resolveComment", id: commentId });
      const comment = comments.find((one) => one.id === commentId);
      if (comment !== undefined) comment.resolved = true;
      return Promise.resolve();
    },
    listSummaryComments: () => Promise.resolve([]),
    createSummaryComment: () => Promise.resolve(),
    updateSummaryComment: () => Promise.resolve(),
    postStatus: () => Promise.resolve(),
  };
}

type Publish = typeof publishReview;

function publishOn(
  publish: Publish,
  scm: ScmPort,
  findings: readonly Finding[],
  lineTextOf: (file: string, line: number) => string | undefined,
  resolvedIn?: string,
): ReturnType<Publish> {
  return publish(scm, {
    findings,
    proposals: [],
    droppedUncited: 0,
    filtered: 0,
    gate: evaluateGate(findings, "MAJOR"),
    commitStatus: false,
    tasks: true,
    lineTextOf,
    ...(resolvedIn !== undefined ? { resolvedIn } : {}),
    dryRun: false,
  });
}

/**
 * Publishes the earlier revision's findings, then this run's, on one pull
 * request and names every way the cleanup failed a finding the fix resolved:
 * its task left open or resolved after its comment changed, its comment
 * deleted, or not rewritten to the resolution trace.
 */
export async function rerunProblems(
  prior: readonly PriorFinding[],
  current: readonly Finding[],
  lineTextOf: (file: string, line: number) => string | undefined,
  resolvedIn: string,
  publish: Publish = publishReview,
): Promise<string[]> {
  const scm = memoryBitbucket();
  const before: Finding[] = prior.map((one) => ({ kind: "violation", body: one.title, ...one }));
  // the earlier revision's lines differ from the fixed ones
  await publishOn(publishReview, scm, before, () => "earlier revision");
  const posted = fingerprintEntries(before).map(({ finding }, index) => ({
    finding,
    comment: scm.comments[index],
    task: scm.tasks[index],
  }));
  const kept = new Set(current.map((one) => `${one.file}:${String(one.line)}`));
  const outcome = await publishOn(publish, scm, current, lineTextOf, resolvedIn);
  const problems: string[] = outcome.notices.map((notice) => `rerun notice: ${notice}`);
  for (const { finding, comment, task } of posted) {
    const where = `${finding.file}:${String(finding.line)}`;
    if (kept.has(where) || comment === undefined || task === undefined) continue;
    const order = scm.calls.map((call) => `${call.op}:${call.id}`);
    const resolvedAt = order.indexOf(`resolveTask:${task.id}`);
    const touchedAt = order.findIndex(
      (entry) => entry === `updateComment:${comment.id}` || entry === `deleteComment:${comment.id}`,
    );
    if (resolvedAt < 0 || scm.tasks.find((one) => one.id === task.id)?.resolved !== true) {
      problems.push(`rerun ${where}: task not resolved`);
    } else if (touchedAt >= 0 && touchedAt < resolvedAt) {
      problems.push(`rerun ${where}: comment changed before its task was resolved`);
    }
    const now = scm.comments.find((one) => one.id === comment.id);
    if (now === undefined) {
      problems.push(`rerun ${where}: comment deleted instead of rewritten`);
    } else if (!now.body.split("\n").some((line) => line.startsWith(RESOLVED_PREFIX))) {
      problems.push(`rerun ${where}: comment not rewritten to "${RESOLVED_PREFIX.trim()}"`);
    }
  }
  return problems;
}
