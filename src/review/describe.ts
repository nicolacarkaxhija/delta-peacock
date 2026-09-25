import { ToolError } from "../errors.js";
import type { ModelRequest } from "../model/port.js";
import { parseJson } from "./parse.js";

export const DESCRIPTION_START = "<!-- delta-peacock:description:start -->";
export const DESCRIPTION_END = "<!-- delta-peacock:description:end -->";

/** Visible fence lines for hosts that print HTML comments (Bitbucket). */
export const VISIBLE_DESCRIPTION_START = "### Change summary";
export const VISIBLE_DESCRIPTION_END = "_Generated summary; replaced on every run._";

interface Fence {
  start: string;
  end: string;
  join: string;
}

const HIDDEN_FENCE: Fence = { start: DESCRIPTION_START, end: DESCRIPTION_END, join: "\n" };
const VISIBLE_FENCE: Fence = {
  start: VISIBLE_DESCRIPTION_START,
  end: VISIBLE_DESCRIPTION_END,
  join: "\n\n",
};

export interface DescriptionUpsert {
  body: string;
  /** True when an earlier section was replaced rather than a new one appended. */
  replaced: boolean;
}

/**
 * Replaces the fenced section in place, or appends one; the author's own
 * prose outside the fence is never touched. Without markers the fence is a
 * visible heading and footer, and a marker-fenced section from an earlier
 * version is replaced by it.
 */
export function upsertDescription(
  existing: string,
  section: string,
  markers = true,
): DescriptionUpsert {
  const fence = markers ? HIDDEN_FENCE : VISIBLE_FENCE;
  const fenced = [fence.start, section.trim(), fence.end].join(fence.join);
  for (const known of markers ? [HIDDEN_FENCE] : [VISIBLE_FENCE, HIDDEN_FENCE]) {
    const end = existing.indexOf(known.end);
    const start = end === -1 ? -1 : existing.lastIndexOf(known.start, end);
    if (start !== -1) {
      const body = existing.slice(0, start) + fenced + existing.slice(end + known.end.length);
      return { body, replaced: true };
    }
  }
  const body = existing.trim() === "" ? fenced : `${existing.replace(/\s+$/, "")}\n\n${fenced}`;
  return { body, replaced: false };
}

export function upsertDescriptionSection(
  existing: string,
  section: string,
  markers = true,
): string {
  return upsertDescription(existing, section, markers).body;
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
