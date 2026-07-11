import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/loader.js";
import { evaluateGate } from "../domain/gate.js";
import { ToolError } from "../errors.js";
import { mergeBaseDiff } from "../git/diff.js";
import { loadGuidelines } from "../guidelines/loader.js";
import { buildModelPort } from "../model/build.js";
import type { ModelPort } from "../model/port.js";
import { buildReviewPrompt } from "./prompt.js";
import { parseReviewResponse } from "./parse.js";
import { renderReview } from "./render.js";
import { buildReport } from "./report.js";

export interface ReviewDeps {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  out: (text: string) => void;
  err: (text: string) => void;
  /** The model-port seam: tests inject a scripted fake here. */
  modelPort?: ModelPort;
}

export async function runReview(
  deps: ReviewDeps,
  flags: Readonly<Record<string, string>>,
): Promise<number> {
  const config = loadConfig({ root: deps.cwd, env: deps.env, flags });

  const guidelinesDir = path.resolve(deps.cwd, config.review.guidelinesDir);
  const { guidelines, problems } = loadGuidelines(guidelinesDir);
  for (const problem of problems) deps.err(`guideline skipped: ${problem}\n`);
  if (guidelines.length === 0) {
    deps.out("no usable guidelines found; nothing to review against\n");
    return 0;
  }

  const diff = mergeBaseDiff(deps.cwd, config.review.target);
  if (diff.trim() === "") {
    deps.out(`nothing to review: no changes against ${config.review.target}\n`);
    return 0;
  }

  const modelPort = deps.modelPort ?? buildModelPort(config, deps.env);
  const request = buildReviewPrompt(guidelines, diff);
  let reply;
  try {
    reply = await modelPort.complete(request);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(`model call failed: ${(error as Error).message}`);
  }

  const byId = new Map(guidelines.map((guideline) => [guideline.id, guideline]));
  const { violations, droppedUncited } = parseReviewResponse(reply.text, byId);
  const gate = evaluateGate(violations, config.gate.failOn);

  deps.out(renderReview({ violations, droppedUncited, gate }));

  if (config.output.report !== undefined) {
    const reportPath = path.resolve(deps.cwd, config.output.report);
    const report = buildReport({
      violations,
      droppedUncited,
      gate,
      ...(reply.usage ? { usage: reply.usage } : {}),
    });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  return gate.failed ? 2 : 0;
}
