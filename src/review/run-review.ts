import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/loader.js";
import type { RuntimeDeps } from "../deps.js";
import { evaluateGate } from "../domain/gate.js";
import { ToolError } from "../errors.js";
import { acquireDiff, changedFilesFromDiff, resolveTargetRef } from "../git/diff.js";
import { appliesTo } from "../guidelines/languages.js";
import { resolveGuidelines } from "../guidelines/loader.js";
import { buildModelPort } from "../model/build.js";
import { buildReviewPrompt } from "./prompt.js";
import { parseReviewResponse } from "./parse.js";
import { compileCustomPatterns, redactDiff } from "./redact.js";
import { renderReview } from "./render.js";
import { buildReport } from "./report.js";

export type ReviewDeps = RuntimeDeps;

export async function runReview(
  deps: ReviewDeps,
  flags: Readonly<Record<string, string>>,
): Promise<number> {
  const config = loadConfig({ root: deps.cwd, env: deps.env, flags });

  const resolvedTarget = resolveTargetRef(
    deps.cwd,
    config.review.target,
    config.review.fetchTarget,
  );
  for (const notice of resolvedTarget.notices) deps.err(`${notice}\n`);

  const loaded = resolveGuidelines(
    deps.cwd,
    config.review.guidelinesRef,
    config.review.guidelinesDir,
    resolvedTarget.ref,
  );
  for (const notice of loaded.notices) deps.err(`${notice}\n`);
  for (const problem of loaded.problems) deps.err(`guideline skipped: ${problem}\n`);
  if (loaded.guidelines.length === 0) {
    deps.out("no usable guidelines found; nothing to review against\n");
    return 0;
  }

  const acquired = acquireDiff(
    deps.cwd,
    {
      target: config.review.target,
      fetchTarget: config.review.fetchTarget,
      include: config.review.include,
      exclude: config.review.exclude,
      maxDiffBytes: config.review.maxDiffBytes,
      ...(config.review.lastReviewedCommit !== undefined
        ? { lastReviewedCommit: config.review.lastReviewedCommit }
        : {}),
    },
    resolvedTarget,
  );
  for (const notice of acquired.notices) deps.err(`${notice}\n`);
  if (acquired.skipped === "too-large") {
    deps.out("review skipped: the diff exceeds the configured size ceiling\n");
    return 0;
  }
  const diff = acquired.text;
  if (diff.trim() === "") {
    deps.out(`nothing to review: no changes against ${acquired.targetRef}\n`);
    return 0;
  }

  const changedFiles = changedFilesFromDiff(diff);
  const guidelines = loaded.guidelines.filter((guideline) => appliesTo(guideline, changedFiles));
  const inapplicable = loaded.guidelines.length - guidelines.length;
  if (inapplicable > 0) {
    deps.err(`${String(inapplicable)} guideline(s) do not apply to this change\n`);
  }
  if (guidelines.length === 0) {
    deps.out("no guidelines apply to this change; nothing to review against\n");
    return 0;
  }

  const redacted = redactDiff(diff, compileCustomPatterns(config.redaction.patterns));
  const redactionTotal = Object.values(redacted.counts).reduce((sum, n) => sum + n, 0);
  if (redactionTotal > 0) {
    deps.err(`${String(redactionTotal)} secret-shaped value(s) redacted before the model call\n`);
  }

  const modelPort = deps.modelPort ?? buildModelPort(config, deps.env);
  const request = buildReviewPrompt(guidelines, redacted.text);
  let reply;
  try {
    reply = await modelPort.complete(request);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(`model call failed: ${(error as Error).message}`);
  }

  const byId = new Map(guidelines.map((guideline) => [guideline.id, guideline]));
  const { violations, droppedUncited, adjustedLines } = parseReviewResponse(reply.text, byId);
  const gate = evaluateGate(violations, config.gate.failOn);

  deps.out(renderReview({ violations, droppedUncited, adjustedLines, gate }));

  if (config.output.report !== undefined) {
    const reportPath = path.resolve(deps.cwd, config.output.report);
    const report = buildReport({
      violations,
      droppedUncited,
      adjustedLines,
      redactions: redacted.counts,
      gate,
      ...(reply.usage ? { usage: reply.usage } : {}),
    });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  return gate.failed ? 2 : 0;
}
