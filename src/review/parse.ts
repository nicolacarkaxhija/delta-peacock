import { z } from "zod";
import { type Finding, type Observation, type Violation } from "../domain/finding.js";
import type { Guideline, StructuralCheck } from "../domain/guideline.js";
import { SEVERITIES, severityRank, type Severity } from "../domain/severity.js";
import { ToolError } from "../errors.js";
import { appliesTo } from "../guidelines/languages.js";
import { plainBody, plainTitle } from "./prose.js";

/** Models write null for "no value" (`"suggestion": null`); that reads as absent, never as malformed. */
const absentIfNull = <T extends z.ZodType>(schema: T) =>
  schema.nullish().transform((value) => value ?? undefined);

const RawFinding = z.object({
  guidelineId: absentIfNull(z.string()),
  file: z.string().min(1),
  line: z.unknown(),
  title: absentIfNull(z.string()).transform((value) => value ?? ""),
  body: absentIfNull(z.string()).transform((value) => value ?? ""),
  severity: absentIfNull(z.enum(SEVERITIES)),
  confidence: absentIfNull(z.number().min(0).max(1)),
  suggestion: absentIfNull(z.string()),
  quote: absentIfNull(z.string()),
  guidelineQuote: absentIfNull(z.string()),
  proposedGuideline: absentIfNull(
    z.object({
      id: z.string().min(1),
      severity: z.enum(SEVERITIES),
      rationale: z.string().default(""),
    }),
  ),
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

/**
 * A raw model element the parser refused, kept for diagnostics (never a
 * finding). The `structural:*` reasons are not raised here -- they come from
 * the post-parse structural verifier, once relocation has settled each
 * finding's real line -- but share this shape so `--explain-drops` and the
 * report's rejected-candidates list cover every gate uniformly.
 */
export interface RejectedCandidate {
  reason:
    | "malformed"
    | "uncited"
    | "out-of-scope"
    | "misquoted"
    | "good-example"
    | "comment-move"
    | `structural:${StructuralCheck}`;
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
  /** Violations whose guidelineQuote is not in the cited guideline: an invented rule, dropped. */
  droppedMisquoted: number;
  /** The payloads behind the drop counts, for --explain-drops and the report. */
  rejected: RejectedCandidate[];
}

/** Shared with the structural verifier, so every rejected-candidate payload is capped alike. */
export const REJECTED_RAW_CAP = 500;
const rawOf = (candidate: unknown): string => JSON.stringify(candidate).slice(0, REJECTED_RAW_CAP);

/** Each balanced `open`..close slice, string-aware, in order of appearance. */
function balancedSlices(text: string, open: "{" | "["): string[] {
  const close = open === "{" ? "}" : "]";
  const slices: string[] = [];
  for (let start = text.indexOf(open); start !== -1; start = text.indexOf(open, start + 1)) {
    let depth = 0;
    let inString = false;
    for (let at = start; at < text.length; at += 1) {
      const char = text[at];
      if (inString) {
        if (char === "\\") at += 1;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === open) depth += 1;
      else if (char === close && --depth === 0) {
        slices.push(text.slice(start, at + 1));
        break;
      }
    }
  }
  return slices;
}

/** Candidate JSON slices in order of confidence; objects before arrays. */
function jsonCandidates(text: string): string[] {
  const trimmed = text.trim();
  const candidates: string[] = [];
  for (const fenced of trimmed.matchAll(/```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n```/g)) {
    if (fenced[1] !== undefined) candidates.push(fenced[1]);
  }
  candidates.push(...balancedSlices(trimmed, "{"));
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
  candidates.push(...balancedSlices(trimmed, "["));
  return candidates;
}

const isContainer = (value: unknown): boolean => typeof value === "object" && value !== null;

/**
 * Tolerant JSON extraction shared by every command that reads a model reply:
 * the first object or array, fenced or wrapped in prose, that `accept` takes.
 */
export function parseJson(text: string, accept: (value: unknown) => boolean = () => true): unknown {
  let lastError = "model response held no JSON object";
  for (const candidate of jsonCandidates(text)) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (accept(value)) return value;
      lastError = "model response held no JSON object of the expected shape";
    } catch (error) {
      lastError = `model response was not valid JSON: ${(error as Error).message}`;
    }
  }
  throw new ToolError(lastError);
}

/** A findings envelope, or a bare array of finding objects a model sent without one. */
function isReviewShape(value: unknown): boolean {
  // an empty array in prose ("returns []") must never read as a clean review
  if (Array.isArray(value)) return value.length > 0 && value.every(isContainer);
  return isContainer(value) && "findings" in (value as object);
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

/** Whitespace collapsed, wrapping quotes and markdown emphasis gone: what a verbatim quote must survive. */
function normalizeQuote(text: string): string {
  return text
    .replace(/[*`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“‘]+|["'”’]+$/g, "")
    .trim();
}

/** Shorter quotes ("dashes") prove nothing about which sentence was applied. */
const MIN_GUIDELINE_QUOTE = 12;

/** True when the quote is a verbatim passage of the guideline's title or body. */
export function quotesGuideline(quote: string | undefined, guideline: Guideline): boolean {
  if (quote === undefined) return false;
  const wanted = normalizeQuote(quote);
  if (wanted.length < MIN_GUIDELINE_QUOTE) return false;
  return normalizeQuote(`${guideline.title}\n${guideline.body}`).includes(wanted);
}

/** Undefined means uncited with the general pass off; out-of-scope and misquoted are their own lanes. */
function toFinding(
  raw: RawShape,
  line: number,
  options: ParseOptions,
): Finding | undefined | "out-of-scope" | "misquoted" {
  const confidence = raw.confidence !== undefined ? { confidence: raw.confidence } : {};
  const suggestion = {
    ...(raw.suggestion !== undefined && raw.suggestion !== ""
      ? { suggestion: raw.suggestion }
      : {}),
    ...(raw.quote !== undefined && raw.quote.trim() !== "" ? { quote: raw.quote } : {}),
  };
  const guideline =
    raw.guidelineId === undefined ? undefined : options.guidelinesById.get(raw.guidelineId);
  if (guideline !== undefined && !appliesTo(guideline, [raw.file])) {
    // the guideline itself says it does not govern this file; deterministic drop
    return "out-of-scope";
  }
  if (guideline !== undefined) {
    // a finding stands on a sentence the guideline really says, never on a paraphrase
    if (!quotesGuideline(raw.guidelineQuote, guideline)) return "misquoted";
    const violation: Violation = {
      kind: "violation",
      guidelineId: guideline.id,
      ...(guideline.pack !== undefined ? { pack: guideline.pack } : {}),
      severity: guideline.severity,
      file: raw.file,
      line,
      title: plainTitle(raw.title === "" ? guideline.title : raw.title, guideline.id),
      body: plainBody(raw.body),
      guidelineQuote: String(raw.guidelineQuote),
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
    title: plainTitle(raw.title === "" ? "Observation" : raw.title),
    body: plainBody(raw.body),
    ...confidence,
    ...suggestion,
    ...(raw.proposedGuideline ? { proposedGuideline: raw.proposedGuideline } : {}),
  };
  return observation;
}

export function parseReviewResponse(text: string, options: ParseOptions): ParsedReview {
  const bareEmpty = /^(?:```[a-zA-Z]*\s*)?\[\s*\](?:\s*```)?$/.test(text.trim());
  const value = bareEmpty ? [] : parseJson(text, isReviewShape);
  const result = RawResponse.safeParse(Array.isArray(value) ? { findings: value } : value);
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
  let droppedMisquoted = 0;
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
    if (finding === "misquoted") {
      droppedMisquoted += 1;
      rejected.push({ reason: "misquoted", raw: rawOf(candidate), ...meta });
      continue;
    }
    if (finding === undefined) {
      droppedUncited += 1;
      rejected.push({ reason: "uncited", raw: rawOf(candidate), ...meta });
      continue;
    }
    findings.push(finding);
  }
  return {
    findings,
    droppedUncited,
    droppedOutOfScope,
    adjustedLines,
    droppedMalformed,
    droppedMisquoted,
    rejected,
  };
}
