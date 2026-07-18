import { z } from "zod";
import type { Finding, Observation, Violation } from "../domain/finding.js";
import type { Guideline } from "../domain/guideline.js";
import { SEVERITIES, severityRank, type Severity } from "../domain/severity.js";
import { ToolError } from "../errors.js";

const RawFinding = z.object({
  guidelineId: z.string().optional(),
  file: z.string().min(1),
  line: z.unknown(),
  title: z.string().default(""),
  body: z.string().default(""),
  severity: z.enum(SEVERITIES).optional(),
  confidence: z.number().min(0).max(1).optional(),
  suggestion: z.string().optional(),
  proposedGuideline: z
    .object({
      id: z.string().min(1),
      severity: z.enum(SEVERITIES),
      rationale: z.string().default(""),
    })
    .optional(),
});

const RawResponse = z.object({
  findings: z.array(RawFinding).default([]),
});

export interface ParseOptions {
  guidelinesById: ReadonlyMap<string, Guideline>;
  /** When on, uncited findings become observations instead of being dropped. */
  generalPass: boolean;
  /** The most severe an observation may be; the model cannot exceed it. */
  observationSeverityCap: Severity;
}

export interface ParsedReview {
  findings: Finding[];
  /** Findings the model reported without citing a known guideline, dropped. */
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

/** Tolerant JSON extraction shared by every command that reads a model reply. */
export function parseJson(text: string): unknown {
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

/** The cap wins whenever the model claims something more severe. */
function capSeverity(claimed: Severity | undefined, cap: Severity): Severity {
  if (claimed === undefined) return cap;
  return severityRank(claimed) < severityRank(cap) ? cap : claimed;
}

type RawShape = z.infer<typeof RawFinding>;

function normalizeLine(raw: unknown): { line: number; adjusted: boolean } {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1) {
    return { line: raw, adjusted: false };
  }
  return { line: 1, adjusted: true };
}

/** Undefined means the finding is uncited and the general pass is off: dropped. */
function toFinding(raw: RawShape, line: number, options: ParseOptions): Finding | undefined {
  const confidence = raw.confidence !== undefined ? { confidence: raw.confidence } : {};
  const suggestion =
    raw.suggestion !== undefined && raw.suggestion !== "" ? { suggestion: raw.suggestion } : {};
  const guideline =
    raw.guidelineId === undefined ? undefined : options.guidelinesById.get(raw.guidelineId);
  if (guideline !== undefined) {
    const violation: Violation = {
      kind: "violation",
      guidelineId: guideline.id,
      severity: guideline.severity,
      file: raw.file,
      line,
      title: raw.title === "" ? guideline.title : raw.title,
      body: raw.body,
      ...confidence,
      ...suggestion,
    };
    return violation;
  }
  if (!options.generalPass) return undefined;
  const observation: Observation = {
    kind: "observation",
    severity: capSeverity(raw.severity, options.observationSeverityCap),
    file: raw.file,
    line,
    title: raw.title === "" ? "Observation" : raw.title,
    body: raw.body,
    ...confidence,
    ...suggestion,
    ...(raw.proposedGuideline ? { proposedGuideline: raw.proposedGuideline } : {}),
  };
  return observation;
}

export function parseReviewResponse(text: string, options: ParseOptions): ParsedReview {
  const result = RawResponse.safeParse(parseJson(text));
  if (!result.success) {
    throw new ToolError(
      `model response did not match the expected shape: ${result.error.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }
  const findings: Finding[] = [];
  let droppedUncited = 0;
  let adjustedLines = 0;
  for (const raw of result.data.findings) {
    const { line, adjusted } = normalizeLine(raw.line);
    if (adjusted) adjustedLines += 1;
    const finding = toFinding(raw, line, options);
    if (finding === undefined) {
      droppedUncited += 1;
      continue;
    }
    findings.push(finding);
  }
  return { findings, droppedUncited, adjustedLines };
}
