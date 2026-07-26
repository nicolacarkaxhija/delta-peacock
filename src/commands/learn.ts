import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/loader.js";
import { checkBudget, guardActive } from "../cost/guard.js";
import { defaultCounterPath, monthKey, recordSpend } from "../cost/counter.js";
import type { RuntimeDeps } from "../deps.js";
import { SEVERITIES, type Severity } from "../domain/severity.js";
import { ToolError } from "../errors.js";
import { buildModelPort } from "../model/build.js";
import { anyRateConfigured, computeCost } from "../model/usage.js";
import { renderDraft, type Draft } from "../guidelines/draft.js";
import { parseJson } from "../review/parse.js";
import { buildScmPort } from "../scm/build.js";
import type { CommentSignal } from "../scm/port.js";
import { isDryRun } from "../scm/publish.js";

const FINDING_MARKER = /<!-- delta-peacock:finding:([0-9a-f]+(?:-\d+)?) -->/;
const SEVERITY_LEAD = /^\*\*(BLOCKER|CRITICAL|MAJOR|MINOR|INFO)\*\*\s*/;
const CITED_ID = /`([a-z0-9][a-z0-9-]*)`/;

export interface Evidence {
  fingerprint: string;
  guidelineId?: string;
  severity?: string;
  title: string;
  path?: string;
  up: number;
  down: number;
  replies: string[];
}

/** Only the reviewer's own comments count; the marker is the identity check. */
export function evidenceFrom(signals: readonly CommentSignal[]): Evidence[] {
  const evidence: Evidence[] = [];
  for (const signal of signals) {
    const fingerprint = FINDING_MARKER.exec(signal.body)?.[1];
    if (fingerprint === undefined) continue;
    const firstLine = signal.body.split("\n")[0] ?? "";
    const severity = SEVERITY_LEAD.exec(firstLine)?.[1];
    const guidelineId = CITED_ID.exec(firstLine)?.[1];
    const title = firstLine.replace(SEVERITY_LEAD, "").split(" — ")[0]?.trim();
    evidence.push({
      fingerprint,
      ...(guidelineId !== undefined ? { guidelineId } : {}),
      ...(severity !== undefined ? { severity } : {}),
      title: title === undefined || title === "" ? "(untitled)" : title,
      ...(signal.path !== undefined ? { path: signal.path } : {}),
      up: signal.reactions.up,
      down: signal.reactions.down,
      replies: signal.replies,
    });
  }
  return evidence;
}

/** Kept stable so provider-side prompt caching can hit across runs. */
const SYSTEM = [
  "You are the learnings pass of delta-peacock, a guideline-anchored code reviewer.",
  "You receive the team's reactions to past review comments: thumbs, replies, and which",
  "guideline each comment cited. Propose guideline drafts the team should consider:",
  "recurring accepted observations become new guidelines; consistently rejected findings",
  "may deserve a scope note or a softer severity on the cited guideline.",
  "Only propose what the evidence supports. Reply with JSON only:",
  '{"drafts": [{"id": "<kebab-case>", "severity": "BLOCKER|CRITICAL|MAJOR|MINOR|INFO",',
  '"title": "<short>", "body": "<the rule, in normative prose>", "rationale": "<one line citing the evidence>",',
  '"languages": ["<language>"]}]}',
  "languages is optional; omit it for language-agnostic rules. An empty drafts array is a fine answer.",
].join("\n");

const DRAFT_ID = /^[a-z][a-z0-9-]*$/;

function parseDrafts(text: string, notices: string[]): Draft[] {
  const parsed = parseJson(text);
  const raw = (parsed as { drafts?: unknown }).drafts;
  if (!Array.isArray(raw)) throw new ToolError("learn reply held no drafts array");
  const drafts: Draft[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = record["id"];
    const severity = record["severity"];
    const title = record["title"];
    const body = record["body"];
    const rationale = record["rationale"];
    if (
      typeof id !== "string" ||
      !DRAFT_ID.test(id) ||
      typeof severity !== "string" ||
      !(SEVERITIES as readonly string[]).includes(severity) ||
      typeof title !== "string" ||
      typeof body !== "string" ||
      typeof rationale !== "string"
    ) {
      notices.push(`skipped an unusable draft: ${JSON.stringify(record["id"] ?? "(no id)")}`);
      continue;
    }
    const languages = record["languages"];
    drafts.push({
      id,
      severity: severity as Severity,
      title,
      body,
      rationale,
      ...(Array.isArray(languages) && languages.every((l) => typeof l === "string")
        ? { languages: languages }
        : {}),
    });
  }
  return drafts;
}

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
  const scm = deps.scmPort ?? buildScmPort(config, deps.env);
  if (scm.listCommentSignals === undefined) {
    throw new ToolError(`the ${config.scm.provider} provider cannot read comment signals yet`);
  }
  const evidence = evidenceFrom(await scm.listCommentSignals());
  if (evidence.length === 0) {
    deps.out("nothing to learn: no reviewer comments with reactions found\n");
    return 0;
  }

  const request = { system: SYSTEM, user: JSON.stringify(evidence, null, 2) };
  if (isDryRun(config)) {
    deps.out(`dry run: ${String(evidence.length)} signal(s) collected, no model was called\n`);
    return 0;
  }
  const now = deps.clock?.() ?? new Date();
  if (guardActive(config)) {
    const decision = await checkBudget(config, request, now);
    for (const notice of decision.notices) deps.err(`${notice}\n`);
    if (!decision.allowed) {
      for (const reason of decision.reasons) deps.out(`budget: ${reason}\n`);
      deps.out("learn blocked by the cost guard before any model call\n");
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
  if (reply.usage && anyRateConfigured(config.cost)) {
    const spent = computeCost(reply.usage, config.cost).total;
    recordSpend(config.cost.counterPath ?? defaultCounterPath(), monthKey(now), spent);
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
