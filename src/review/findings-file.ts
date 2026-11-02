import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Severity } from "../domain/severity.js";
import { guidelineLine, twoSentences } from "../scm/comment-format.js";
import type { ReportedFinding } from "./report.js";

/** The findings file the review writes into the folder `output.findingsDir` names. */
export const FINDINGS_FILE = "reviewer.json";
export const FINDINGS_PRODUCER = "reviewer";
/** The engine's document id; schema/finding.schema.json is its vendored contract. */
const FINDINGS_DOCUMENT = "findings-1";

/** The engine knows three severities; the grouping is the one the SARIF artifact uses. */
const ENGINE_SEVERITIES: Record<Severity, "error" | "warning" | "info"> = {
  BLOCKER: "error",
  CRITICAL: "error",
  MAJOR: "warning",
  MINOR: "info",
  INFO: "info",
};

/** The reason as a comment gives it, then its guideline sentence, on one line. */
function messageOf(finding: ReportedFinding): string {
  const reason = twoSentences(finding.body === "" ? finding.title : finding.body);
  const rule = guidelineLine(finding);
  return rule === undefined ? reason : `${reason} ${rule}`;
}

const flat = (text: string): string => text.trim().replace(/\s+/g, " ");

/** The guideline, the flagged code and the guideline sentence; never the path, the line or the model's wording. */
function fingerprintOf(finding: ReportedFinding): string {
  const code = flat(finding.lineText ?? finding.quote ?? "");
  const parts =
    finding.kind === "violation"
      ? [finding.guidelineId, code, flat(finding.guidelineQuote ?? "")]
      : ["observation", code, ""];
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

/** The findings the file holds: not baselined, and on a line. */
const placed = (findings: readonly ReportedFinding[]): ReportedFinding[] =>
  findings.filter(
    (finding) => finding.baselined !== true && finding.unplaced !== true && finding.line > 0,
  );

/** The fingerprints of the findings the file holds, as the review record lists them. */
export function fingerprintsOf(findings: readonly ReportedFinding[]): string[] {
  return placed(findings).map(fingerprintOf);
}

/**
 * A findings file in the engine's shape, each finding with the reviewer's own fingerprint.
 * Baselined findings and findings on no line stay out.
 */
export function renderFindingsFile(
  findings: readonly ReportedFinding[],
  evidence?: string,
): string {
  const written = findings
    .filter(
      (finding) => finding.baselined !== true && finding.unplaced !== true && finding.line > 0,
    )
    .map((finding) => ({
      producer: FINDINGS_PRODUCER,
      rule: finding.kind === "violation" ? finding.guidelineId : "observation",
      severity: ENGINE_SEVERITIES[finding.severity],
      file: finding.file,
      range: { startLine: finding.line },
      message: messageOf(finding),
      ...(finding.suggestion !== undefined ? { suggested: finding.suggestion } : {}),
      ...(evidence !== undefined ? { evidence } : {}),
      fingerprint: fingerprintOf(finding),
    }));
  return `${JSON.stringify({ schema: FINDINGS_DOCUMENT, findings: written }, null, 2)}\n`;
}

/** Writes the findings file into dir, replacing the one an earlier review left. */
export function writeFindingsFile(
  cwd: string,
  dir: string,
  findings: readonly ReportedFinding[],
  evidence?: string,
): void {
  const folder = path.resolve(cwd, dir);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, FINDINGS_FILE), renderFindingsFile(findings, evidence));
}
