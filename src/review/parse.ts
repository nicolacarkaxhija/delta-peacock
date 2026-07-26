import { z } from "zod";
import type { Finding, Observation, Violation } from "../domain/finding.js";
import type { Guideline } from "../domain/guideline.js";
import { SEVERITIES, severityRank, type Severity } from "../domain/severity.js";
import { ToolError } from "../errors.js";
import { appliesTo } from "../guidelines/languages.js";

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

// the envelope is read loosely so one off-shape element cannot fail the whole
// array; each finding is validated on its own below
const RawResponse = z.object({
  findings: z.array(z.unknown()).default([]),
});

export interface ParseOptions {
  guidelinesById: ReadonlyMap<string, Guideline>;
  /** When on, uncited findings become observations instead of being dropped. */
  generalPass: boolean;
  /** The most severe an observation may be; the model cannot exceed it. */
  observationSeverityCap: Severity;
}

/** A raw model element the parser refused, kept for diagnostics (never a finding). */
export interface RejectedCandidate {
  reason: "malformed" | "uncited" | "out-of-scope";
  /** The candidate's JSON, capped; the diff it came from was already redacted. */
  raw: string;
  /** The cited guideline id, when the candidate carried one. */
  guidelineId?: string;
  /** The candidate's title, when it parsed as a finding (uncited/out-of-scope). */
  title?: string;
  /** The severity the model claimed, for an uncited candidate. */
  severity?: Severity;
}

export interface ParsedReview {
  findings: Finding[];
  /** Findings the model reported without citing a known guideline, dropped. */
  droppedUncited: number;
  /** Violations citing a guideline whose declared scope excludes the file, dropped. */
  droppedOutOfScope: number;
  /** Findings whose line number was missing or invalid and got pinned to 1. */
  adjustedLines: number;
  /** Findings in a shape we could not read at all (or a truncated tail), dropped. */
  droppedMalformed: number;
  /** The payloads behind the drop counts, for --explain-drops and the report. */
  rejected: RejectedCandidate[];
}

const REJECTED_RAW_CAP = 500;
const rawOf = (candidate: unknown): string => JSON.stringify(candidate).slice(0, REJECTED_RAW_CAP);

/** Candidate JSON slices in order of confidence; the first that parses wins. */
function jsonCandidates(text: string): string[] {
  const trimmed = text.trim();
  const candidates: string[] = [];
  const fenced = /^```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n```/.exec(trimmed);
  if (fenced?.[1] !== undefined) candidates.push(fenced[1]);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const greedy = trimmed.slice(start, end + 1);
    candidates.push(greedy);
    // a reply truncated mid-array (a model that hit its output cap) leaves the
    // findings array open; recover its complete elements by closing it. Only a
    // guarded fallback: it is tried after the intact slices and skipped if wrong.
    if (/"findings"\s*:\s*\[/.test(trimmed)) candidates.push(`${greedy}]}`);
  }
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

/** Undefined means uncited with the general pass off; out-of-scope is its own lane. */
function toFinding(
  raw: RawShape,
  line: number,
  options: ParseOptions,
): Finding | undefined | "out-of-scope" {
  const confidence = raw.confidence !== undefined ? { confidence: raw.confidence } : {};
  const suggestion =
    raw.suggestion !== undefined && raw.suggestion !== "" ? { suggestion: raw.suggestion } : {};
  const guideline =
    raw.guidelineId === undefined ? undefined : options.guidelinesById.get(raw.guidelineId);
  if (guideline !== undefined && !appliesTo(guideline, [raw.file])) {
    // the guideline itself says it does not govern this file; deterministic drop
    return "out-of-scope";
  }
  if (guideline !== undefined) {
    const violation: Violation = {
      kind: "violation",
      guidelineId: guideline.id,
      ...(guideline.pack !== undefined ? { pack: guideline.pack } : {}),
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
  const rejected: RejectedCandidate[] = [];
  let droppedUncited = 0;
  let droppedOutOfScope = 0;
  let adjustedLines = 0;
  let droppedMalformed = 0;
  for (const candidate of result.data.findings) {
    // validate each finding alone: one off-shape element costs one finding, not
    // the whole review, so a single stray field can never blank the gate
    const raw = RawFinding.safeParse(candidate);
    if (!raw.success) {
      droppedMalformed += 1;
      rejected.push({ reason: "malformed", raw: rawOf(candidate) });
      continue;
    }
    const meta = {
      ...(raw.data.guidelineId !== undefined ? { guidelineId: raw.data.guidelineId } : {}),
      ...(raw.data.title !== "" ? { title: raw.data.title } : {}),
      ...(raw.data.severity !== undefined ? { severity: raw.data.severity } : {}),
    };
    const { line, adjusted } = normalizeLine(raw.data.line);
    if (adjusted) adjustedLines += 1;
    const finding = toFinding(raw.data, line, options);
    if (finding === "out-of-scope") {
      droppedOutOfScope += 1;
      rejected.push({ reason: "out-of-scope", raw: rawOf(candidate), ...meta });
      continue;
    }
    if (finding === undefined) {
      droppedUncited += 1;
      rejected.push({ reason: "uncited", raw: rawOf(candidate), ...meta });
      continue;
    }
    findings.push(finding);
  }
  return { findings, droppedUncited, droppedOutOfScope, adjustedLines, droppedMalformed, rejected };
}
