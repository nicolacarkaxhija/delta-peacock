import { SEVERITIES, type Severity } from "../domain/severity.js";
import { ToolError } from "../errors.js";
import type { ModelRequest } from "../model/port.js";
import { parseJson } from "../review/parse.js";
import { reviewerComment } from "../scm/comment-format.js";
import type { CommentSignal } from "../scm/port.js";
import type { Draft } from "./draft.js";

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

/** Only the reviewer's own comments count: its marker, or its author plus heading. */
export function evidenceFrom(signals: readonly CommentSignal[]): Evidence[] {
  const evidence: Evidence[] = [];
  for (const signal of signals) {
    const own = reviewerComment(signal);
    if (own === undefined) continue;
    const { fingerprint, parsed } = own;
    evidence.push({
      fingerprint,
      ...(parsed?.guidelineId !== undefined ? { guidelineId: parsed.guidelineId } : {}),
      ...(parsed !== undefined ? { severity: parsed.severity } : {}),
      title: parsed === undefined || parsed.title === "" ? "(untitled)" : parsed.title,
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

/** The learnings request for the evidence gathered from an SCM's reactions. */
export function buildLearnRequest(evidence: readonly Evidence[]): ModelRequest {
  return { system: SYSTEM, user: JSON.stringify(evidence, null, 2) };
}

const DRAFT_ID = /^[a-z][a-z0-9-]*$/;

export function parseDrafts(text: string, notices: string[]): Draft[] {
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
