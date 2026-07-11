import { z } from "zod";
import type { Violation } from "../domain/finding.js";
import type { Guideline } from "../domain/guideline.js";
import { ToolError } from "../errors.js";

const RawFinding = z.object({
  guidelineId: z.string(),
  file: z.string().min(1),
  line: z.number().int().min(1).catch(1),
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
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(trimmed);
  if (fenced?.[1] !== undefined) return fenced[1];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new ToolError("model response held no JSON object");
  }
  return trimmed.slice(start, end + 1);
}

export function parseReviewResponse(
  text: string,
  guidelinesById: ReadonlyMap<string, Guideline>,
): ParsedReview {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(`model response was not valid JSON: ${(error as Error).message}`);
  }
  const result = RawResponse.safeParse(parsed);
  if (!result.success) {
    throw new ToolError(
      `model response did not match the expected shape: ${result.error.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }
  const violations: Violation[] = [];
  let droppedUncited = 0;
  for (const raw of result.data.findings) {
    const guideline = guidelinesById.get(raw.guidelineId);
    if (guideline === undefined) {
      droppedUncited += 1;
      continue;
    }
    violations.push({
      kind: "violation",
      guidelineId: guideline.id,
      severity: guideline.severity,
      file: raw.file,
      line: raw.line,
      title: raw.title === "" ? guideline.title : raw.title,
      body: raw.body,
    });
  }
  return { violations, droppedUncited };
}
