import { z } from "zod";
import type { Violation } from "../domain/finding.js";
import type { Guideline } from "../domain/guideline.js";
import { ToolError } from "../errors.js";

const RawFinding = z.object({
  guidelineId: z.string(),
  file: z.string().min(1),
  line: z.unknown(),
  title: z.string().default(""),
  body: z.string().default(""),
});

const RawResponse = z.object({
  findings: z.array(RawFinding).default([]),
});

export interface ParsedReview {
  violations: Violation[];
  /** Findings the model reported without citing a known guideline. */
  droppedUncited: number;
  /** Findings whose line number was missing or invalid and got pinned to 1. */
  adjustedLines: number;
}

/** Candidate JSON slices in order of confidence; the first that parses wins. */
function jsonCandidates(text: string): string[] {
  const trimmed = text.trim();
  const candidates: string[] = [];
  const fenced = /^```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n```/.exec(trimmed);
  if (fenced?.[1] !== undefined) candidates.push(fenced[1]);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1));
  return candidates;
}

function parseJson(text: string): unknown {
  let lastError = "model response held no JSON object";
  for (const candidate of jsonCandidates(text)) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = `model response was not valid JSON: ${(error as Error).message}`;
    }
  }
  throw new ToolError(lastError);
}

export function parseReviewResponse(
  text: string,
  guidelinesById: ReadonlyMap<string, Guideline>,
): ParsedReview {
  const result = RawResponse.safeParse(parseJson(text));
  if (!result.success) {
    throw new ToolError(
      `model response did not match the expected shape: ${result.error.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }
  const violations: Violation[] = [];
  let droppedUncited = 0;
  let adjustedLines = 0;
  for (const raw of result.data.findings) {
    const guideline = guidelinesById.get(raw.guidelineId);
    if (guideline === undefined) {
      droppedUncited += 1;
      continue;
    }
    let line = 1;
    if (typeof raw.line === "number" && Number.isInteger(raw.line) && raw.line >= 1) {
      line = raw.line;
    } else {
      adjustedLines += 1;
    }
    violations.push({
      kind: "violation",
      guidelineId: guideline.id,
      severity: guideline.severity,
      file: raw.file,
      line,
      title: raw.title === "" ? guideline.title : raw.title,
      body: raw.body,
    });
  }
  return { violations, droppedUncited, adjustedLines };
}
