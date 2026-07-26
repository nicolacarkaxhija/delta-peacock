import { ToolError } from "../errors.js";
import type { ModelRequest } from "../model/port.js";
import { parseJson } from "./parse.js";

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

/** The description request for a redacted diff. */
export function buildDescribeRequest(diff: string): ModelRequest {
  return { system: SYSTEM, user: diff };
}

export interface DescribeReply {
  title?: string;
  summary: string;
}

export function parseDescribeReply(text: string): DescribeReply {
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
