import { loadCredentials } from "../config/credentials.js";
import { loadConfig } from "../config/loader.js";
import type { Config } from "../config/schema.js";
import { checkCostGuard, guardActive } from "../cost/guard.js";
import { defaultCounterPath, monthKey, recordSpend } from "../cost/counter.js";
import type { RuntimeDeps } from "../deps.js";
import { ToolError } from "../errors.js";
import { acquireDiff, resolveTargetRef } from "../git/diff.js";
import { buildModelPort } from "../model/build.js";
import { anyRateConfigured, computeCost } from "../model/usage.js";
import {
  DESCRIPTION_START,
  buildDescribeRequest,
  parseDescribeReply,
  upsertDescriptionSection,
} from "../review/describe.js";
import { compileCustomPatterns, redactDiff } from "../review/redact.js";
import { buildScmPort } from "../scm/build.js";
import { isDryRun } from "../scm/publish.js";

function isLocalOrDry(config: Config): boolean {
  // local-provider behavior lives here; dry-run behavior defers to the shared guard
  return config.scm.provider === "local" || isDryRun(config);
}

export async function runDescribe(
  deps: RuntimeDeps,
  flags: Readonly<Record<string, string>>,
  options: { title: boolean },
): Promise<number> {
  const config = loadConfig({ root: deps.cwd, env: deps.env, flags });

  const resolvedTarget = resolveTargetRef(
    deps.cwd,
    config.review.target,
    config.review.fetchTarget,
  );
  for (const notice of resolvedTarget.notices) deps.err(`${notice}\n`);
  const acquired = acquireDiff(
    deps.cwd,
    {
      target: config.review.target,
      fetchTarget: config.review.fetchTarget,
      include: config.review.include,
      exclude: config.review.exclude,
      maxDiffBytes: config.review.maxDiffBytes,
    },
    resolvedTarget,
  );
  for (const notice of acquired.notices) deps.err(`${notice}\n`);
  if (acquired.skipped === "too-large") {
    deps.out("describe skipped: the diff exceeds the configured size ceiling\n");
    return 0;
  }
  if (acquired.text.trim() === "") {
    deps.out(`nothing to describe: no changes against ${acquired.targetRef}\n`);
    return 0;
  }

  const redacted = redactDiff(acquired.text, compileCustomPatterns(config.redaction.patterns), {
    strict: config.redaction.strict,
  });
  const request = buildDescribeRequest(redacted.text);

  const now = deps.clock?.() ?? new Date();
  if (guardActive(config)) {
    const decision = await checkCostGuard(config, request, now);
    for (const notice of decision.notices) deps.err(`${notice}\n`);
    if (!decision.allowed) {
      for (const reason of decision.reasons) deps.out(`budget: ${reason}\n`);
      deps.out("describe blocked by the cost guard before any model call\n");
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
  const described = parseDescribeReply(reply.text);

  if (reply.usage && anyRateConfigured(config.cost)) {
    const spent = computeCost(reply.usage, config.cost).total;
    await recordSpend(config.cost.counterPath ?? defaultCounterPath(), monthKey(now), spent);
  }

  if (isLocalOrDry(config)) {
    const reason = config.scm.provider === "local" ? "local mode" : "dry run";
    if (options.title && described.title !== undefined) {
      deps.out(`title (${reason}, not written): ${described.title}\n\n`);
    }
    deps.out(`${upsertDescriptionSection("", described.summary)}\n`);
    return 0;
  }

  const scm = deps.scmPort ?? buildScmPort(config, loadCredentials(deps.env));
  if (scm.getPullRequestText === undefined || scm.updatePullRequestText === undefined) {
    throw new ToolError(`the ${config.scm.provider} provider cannot edit descriptions`);
  }
  const current = await scm.getPullRequestText();
  await scm.updatePullRequestText({
    body: upsertDescriptionSection(current.body, described.summary),
    ...(options.title && described.title !== undefined ? { title: described.title } : {}),
  });
  deps.out(
    `description section ${current.body.includes(DESCRIPTION_START) ? "updated" : "added"}` +
      `${options.title && described.title !== undefined ? "; title set" : ""}\n`,
  );
  return 0;
}
