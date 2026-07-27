import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadCredentials } from "../config/credentials.js";
import { loadConfig } from "../config/loader.js";
import { checkCostGuard, guardActive } from "../cost/guard.js";
import { defaultCounterPath, monthKey, recordSpend } from "../cost/counter.js";
import type { RuntimeDeps } from "../deps.js";
import { ToolError } from "../errors.js";
import { buildModelPort } from "../model/build.js";
import { anyRateConfigured, computeCost } from "../model/usage.js";
import { renderDraft } from "../guidelines/draft.js";
import { buildLearnRequest, evidenceFrom, parseDrafts } from "../guidelines/learn.js";
import { buildScmPort } from "../scm/build.js";
import { isDryRun } from "../scm/publish.js";

export interface LearnOptions {
  draftsDir?: string;
  report?: string;
}

export async function runLearn(
  deps: RuntimeDeps,
  flags: Readonly<Record<string, string>>,
  options: LearnOptions,
): Promise<number> {
  const config = loadConfig({ root: deps.cwd, env: deps.env, flags });
  if (config.scm.provider === "local") {
    throw new ToolError("learn reads reactions from an SCM; local mode has none");
  }
  const scm = deps.scmPort ?? buildScmPort(config, loadCredentials(deps.env));
  if (scm.listCommentSignals === undefined) {
    throw new ToolError(`the ${config.scm.provider} provider cannot read comment signals yet`);
  }
  const evidence = evidenceFrom(await scm.listCommentSignals());
  if (evidence.length === 0) {
    deps.out("nothing to learn: no reviewer comments with reactions found\n");
    return 0;
  }

  const request = buildLearnRequest(evidence);
  if (isDryRun(config)) {
    deps.out(`dry run: ${String(evidence.length)} signal(s) collected, no model was called\n`);
    return 0;
  }
  const now = deps.clock?.() ?? new Date();
  if (guardActive(config)) {
    const decision = await checkCostGuard(config, request, now);
    for (const notice of decision.notices) deps.err(`${notice}\n`);
    if (!decision.allowed) {
      for (const reason of decision.reasons) deps.out(`budget: ${reason}\n`);
      deps.out("learn blocked by the cost guard before any model call\n");
      return 1;
    }
  }

  const modelPort = deps.modelPort ?? buildModelPort(config, loadCredentials(deps.env));
  let reply;
  try {
    reply = await modelPort.complete(request);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(`model call failed: ${(error as Error).message}`);
  }
  if (reply.usage && anyRateConfigured(config.cost)) {
    const spent = computeCost(reply.usage, config.cost).total;
    await recordSpend(config.cost.counterPath ?? defaultCounterPath(), monthKey(now), spent);
  }

  const notices: string[] = [];
  const drafts = parseDrafts(reply.text, notices);
  for (const notice of notices) deps.err(`${notice}\n`);

  const draftsDir = path.resolve(deps.cwd, options.draftsDir ?? "guidelines-drafts");
  const written: string[] = [];
  if (drafts.length > 0) mkdirSync(draftsDir, { recursive: true });
  for (const draft of drafts) {
    const file = path.join(draftsDir, `${draft.id}.md`);
    writeFileSync(file, renderDraft(draft));
    written.push(`${draft.id}.md`);
    deps.out(`draft written: ${path.relative(deps.cwd, file)}\n`);
  }
  if (drafts.length === 0) deps.out("the evidence supports no new drafts\n");

  if (options.report !== undefined) {
    writeFileSync(
      path.resolve(deps.cwd, options.report),
      `${JSON.stringify({ evidence, drafts: written }, null, 2)}\n`,
    );
  }
  deps.out(
    `${String(evidence.length)} signal(s), ${String(drafts.length)} draft(s); a human enacts a draft by moving it into the guidelines directory\n`,
  );
  return 0;
}
