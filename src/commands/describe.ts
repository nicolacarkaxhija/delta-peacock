import { loadConfig } from "../config/loader.js";
import type { Config } from "../config/schema.js";
import { checkBudget, guardActive } from "../cost/guard.js";
import { defaultCounterPath, monthKey, recordSpend } from "../cost/counter.js";
import type { RuntimeDeps } from "../deps.js";
import { ToolError } from "../errors.js";
import { acquireDiff, resolveTargetRef } from "../git/diff.js";
import { buildModelPort } from "../model/build.js";
import { anyRateConfigured, computeCost } from "../model/usage.js";
import { parseJson } from "../review/parse.js";
import { compileCustomPatterns, redactDiff } from "../review/redact.js";
import { buildScmPort } from "../scm/build.js";

export const DESCRIPTION_START = "<!-- delta-peacock:description:start -->";
export const DESCRIPTION_END = "<!-- delta-peacock:description:end -->";

/**
 * Replaces the marker-fenced section in place, or appends one; the author's
 * own prose outside the fence is never touched.
 */
export function upsertDescriptionSection(existing: string, section: string): string {
  const fenced = `${DESCRIPTION_START}\n${section.trim()}\n${DESCRIPTION_END}`;
  const start = existing.indexOf(DESCRIPTION_START);
  const end = existing.indexOf(DESCRIPTION_END);
  if (start !== -1 && end > start) {
    return existing.slice(0, start) + fenced + existing.slice(end + DESCRIPTION_END.length);
  }
  return existing.trim() === "" ? fenced : `${existing.replace(/\s+$/, "")}\n\n${fenced}`;
}

/** Kept stable so provider-side prompt caching can hit across runs. */
const SYSTEM = [
  "You are delta-peacock, a code review assistant.",
  "Summarize the change the unified diff makes for the pull request description.",
  "Reply with one JSON object and nothing else:",
  '{"title": "conventional, under 70 characters", "summary": "markdown"}',
  "The summary states what changed and why it matters, in short plain prose.",
  "Use a bullet list only when the change has clearly separable parts.",
  "Never invent motivation the diff does not show.",
].join("\n");

interface DescribeReply {
  title?: string;
  summary: string;
}

function parseDescribeReply(text: string): DescribeReply {
  const parsed = parseJson(text);
  if (typeof parsed !== "object" || parsed === null) {
    throw new ToolError("model reply was not a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record["summary"] !== "string" || record["summary"].trim() === "") {
    throw new ToolError("model reply held no usable summary");
  }
  return {
    summary: record["summary"],
    ...(typeof record["title"] === "string" && record["title"].trim() !== ""
      ? { title: record["title"].trim() }
      : {}),
  };
}

function isLocalOrDry(config: Config): boolean {
  return config.scm.provider === "local" || config.scm.dryRun;
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

  const redacted = redactDiff(acquired.text, compileCustomPatterns(config.redaction.patterns));
  const request = { system: SYSTEM, user: redacted.text };

  const now = deps.clock?.() ?? new Date();
  if (guardActive(config)) {
    const decision = await checkBudget(config, request, now);
    for (const notice of decision.notices) deps.err(`${notice}\n`);
    if (!decision.allowed) {
      for (const reason of decision.reasons) deps.out(`budget: ${reason}\n`);
      deps.out("describe blocked by the cost guard before any model call\n");
      return 1;
    }
  }

  const modelPort = deps.modelPort ?? buildModelPort(config, deps.env);
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
    recordSpend(config.cost.counterPath ?? defaultCounterPath(), monthKey(now), spent);
  }

  if (isLocalOrDry(config)) {
    const reason = config.scm.provider === "local" ? "local mode" : "dry run";
    if (options.title && described.title !== undefined) {
      deps.out(`title (${reason}, not written): ${described.title}\n\n`);
    }
    deps.out(`${upsertDescriptionSection("", described.summary)}\n`);
    return 0;
  }

  const scm = deps.scmPort ?? buildScmPort(config, deps.env);
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
