import { describe, expect, it } from "vitest";
import { memoryBitbucket, rerunProblems } from "../src/backtest/rerun.js";
import type { Finding } from "../src/domain/finding.js";
import type { ScmPort } from "../src/scm/port.js";
import { publishReview } from "../src/scm/publish.js";

const prior = [
  {
    file: "tests/smoke/cart.spec.ts",
    line: 8,
    guidelineId: "web-first-assertions",
    severity: "MAJOR" as const,
    title: "Awaited getter passed into assertion",
  },
];

const fixed = (): string => "await expect(cart.lineItems().first()).toBeVisible();";

/** The 0.1.8 order: delete the comment, which takes its task, then resolve the task. */
const deleteFirst: typeof publishReview = async (scm, input) => {
  const comments = await scm.listInlineComments();
  for (const comment of comments) await scm.deleteComment(comment.id);
  for (const task of (await scm.listTasks?.()) ?? []) {
    await scm.resolveTask?.(task.id);
  }
  return publishReview(scm, { ...input, tasks: false });
};

/** Resolves the task but leaves the comment untouched. */
const resolveOnly: typeof publishReview = async (scm) => {
  for (const task of (await scm.listTasks?.()) ?? []) await scm.resolveTask?.(task.id);
  return { created: 0, updated: 0, deleted: 0, unchanged: 0, notices: ["kept"] };
};

/** Rewrites the comment first, then resolves the task. */
const commentFirst: typeof publishReview = async (scm, input) => {
  for (const comment of await scm.listInlineComments()) {
    await scm.updateComment(comment.id, "Resolved in `abc`");
  }
  for (const task of (await scm.listTasks?.()) ?? []) await scm.resolveTask?.(task.id);
  return publishReview(scm, { ...input, tasks: false });
};

describe("rerun check", () => {
  it("passes the cleanup that resolves the task first and keeps a resolution trace", async () => {
    expect(await rerunProblems(prior, [], fixed, "7afad12655ce")).toEqual([]);
  });

  it("skips a prior finding the rerun still reports", async () => {
    const [first] = prior;
    if (first === undefined) throw new Error("no prior finding");
    const still: Finding = { kind: "violation", body: "b", ...first };
    const problems = await rerunProblems(prior, [still], () => "unchanged", "7afad12655ce");
    expect(problems.filter((problem) => problem.startsWith("rerun tests/"))).toEqual([]);
  });

  it("names the delete then resolve order of 0.1.8", async () => {
    const problems = await rerunProblems(prior, [], fixed, "7afad12655ce", deleteFirst);
    expect(problems).toEqual([
      "rerun tests/smoke/cart.spec.ts:8: task not resolved",
      "rerun tests/smoke/cart.spec.ts:8: comment deleted instead of rewritten",
    ]);
  });

  it("names a comment left without its resolution trace", async () => {
    const problems = await rerunProblems(prior, [], fixed, "7afad12655ce", resolveOnly);
    expect(problems).toEqual([
      "rerun notice: kept",
      'rerun tests/smoke/cart.spec.ts:8: comment not rewritten to "Resolved in"',
    ]);
  });

  it("names a comment changed before its task was resolved", async () => {
    const problems = await rerunProblems(prior, [], fixed, "7afad12655ce", commentFirst);
    expect(problems).toEqual([
      "rerun tests/smoke/cart.spec.ts:8: comment changed before its task was resolved",
    ]);
  });
});

describe("memory bitbucket", () => {
  it("answers 404 for a gone comment or task and threads resolve", async () => {
    const scm: ScmPort = memoryBitbucket();
    await expect(scm.resolveTask?.("9")).rejects.toThrow("404");
    await expect(scm.updateComment("9", "x")).rejects.toThrow("404");
    const id = String(await scm.createInlineComment({ body: "b", path: "a.ts", line: 1 }));
    await scm.resolveComment?.(id);
    await scm.resolveComment?.("9");
    expect((await scm.listInlineComments())[0]?.resolved).toBe(true);
    await scm.deleteComment("9");
    await scm.createSummaryComment("s");
    await scm.updateSummaryComment("s", "t");
    await scm.postStatus("success", "ok");
    expect(await scm.listSummaryComments()).toEqual([]);
    expect(await scm.currentUserId?.()).toBe("reviewer");
  });
});
