import { DEFAULT_DISPLAY_NAME } from "../config/schema.js";
import { fingerprintFrom, type Finding, type ProposedGuideline } from "../domain/finding.js";
import type { GateDecision } from "../domain/gate.js";
import { meetsThreshold, SEVERITIES, type Severity } from "../domain/severity.js";

export const SUMMARY_MARKER = "<!-- delta-peacock:summary -->";
const FINDING_MARKER = /^<!-- delta-peacock:finding:([0-9a-f]+(?:-\d+)?) -->$/;
const ANY_FINDING_MARKER = /<!-- delta-peacock:finding:([0-9a-f]+(?:-\d+)?) -->/;

/** How a pull request host shows the review; defaults suit a host that hides HTML comments. */
export interface Presentation {
  displayName: string;
  /** Marker lines carry identity; off where the host prints them verbatim. */
  markers: boolean;
  /** Fence language for a suggested change; empty for a plain block. */
  suggestionFence: string;
  /** Web link to a repository file on the target branch; absent renders plain ids. */
  fileLink?: (path: string) => string;
  guidelinesDir: string;
  /** Repository doc on how reviews work, linked from a blocked summary. */
  guidePath?: string;
}

export const DEFAULT_PRESENTATION: Presentation = {
  displayName: DEFAULT_DISPLAY_NAME,
  markers: true,
  suggestionFence: "suggestion",
  guidelinesDir: "guidelines",
};

export function severityWord(severity: Severity): string {
  return `${severity.charAt(0)}${severity.slice(1).toLowerCase()}`;
}

/** Only a marker on the comment's final line counts; quoting one in prose does not. */
export function markerFingerprint(body: string): string | undefined {
  const lastLine = String(body.trimEnd().split("\n").at(-1));
  return FINDING_MARKER.exec(lastLine)?.[1];
}

/** Anywhere in the body; for reading back comments whose last line a host may have trimmed. */
export function anyMarkerFingerprint(body: string): string | undefined {
  return ANY_FINDING_MARKER.exec(body)?.[1];
}

export function guidelineUrl(guidelineId: string, presentation: Presentation): string | undefined {
  return presentation.fileLink?.(`${presentation.guidelinesDir}/${guidelineId}.md`);
}

function citation(finding: Finding, presentation: Presentation): string {
  if (finding.kind !== "violation") return "observation";
  // a pack guideline lives outside this repository, so it has no link here
  const url =
    finding.pack === undefined ? guidelineUrl(finding.guidelineId, presentation) : undefined;
  return url === undefined ? `\`${finding.guidelineId}\`` : `[${finding.guidelineId}](${url})`;
}

/** The first two sentences; a sentence ends at . ! or ? followed by space and a capital. */
export function twoSentences(text: string): string {
  const flat = text.trim().replace(/\s+/g, " ");
  const sentences = flat.split(/(?<=[.!?])\s+(?=[A-Z`*"'(])/);
  return sentences.slice(0, 2).join(" ");
}

export function renderCommentBody(
  finding: Finding,
  fingerprint: string,
  presentation: Presentation = DEFAULT_PRESENTATION,
): string {
  const reason = twoSentences(finding.body === "" ? finding.title : finding.body);
  const lines = [
    `**${severityWord(finding.severity)}** · ${citation(finding, presentation)}`,
    "",
    reason,
  ];
  if (finding.suggestion !== undefined) {
    lines.push("", `\`\`\`${presentation.suggestionFence}`, finding.suggestion, "```");
  }
  if (presentation.markers) lines.push("", `<!-- delta-peacock:finding:${fingerprint} -->`);
  return lines.join("\n");
}

const HEADING =
  /^\*\*(Blocker|Critical|Major|Minor|Info)\*\* · (?:\[([^\]\s]+)\]\([^)\s]*\)|`([^`\s]+)`|(observation))$/;
const LEGACY_HEADING = /^\*\*(BLOCKER|CRITICAL|MAJOR|MINOR|INFO)\*\*\s*(.*)$/;
const LEGACY_CITE = /`([^`\s]+)`/;

export interface ParsedComment {
  severity: Severity;
  /** The cited guideline id; absent for an observation. */
  guidelineId?: string;
  /** A short label: the legacy title, or the first sentence of the reason. */
  title: string;
}

/** Reads the heading of an inline finding comment, current or pre 0.1.5 format. */
export function parseFindingComment(body: string): ParsedComment | undefined {
  const lines = body.split("\n");
  const first = lines[0] ?? "";
  const current = HEADING.exec(first);
  if (current !== null) {
    const guidelineId = current[2] ?? current[3];
    const reason = (lines[2] ?? "").split(/(?<=[.!?])\s/)[0]?.trim() ?? "";
    return {
      severity: String(current[1]).toUpperCase() as Severity,
      ...(guidelineId !== undefined ? { guidelineId } : {}),
      title: reason,
    };
  }
  const legacy = LEGACY_HEADING.exec(first);
  if (legacy === null) return undefined;
  const rest = String(legacy[2]);
  const guidelineId = LEGACY_CITE.exec(rest)?.[1];
  return {
    severity: legacy[1] as Severity,
    ...(guidelineId !== undefined ? { guidelineId } : {}),
    title: String(rest.split(" — ")[0]).trim(),
  };
}

/** The fingerprint anchor a comment heading cites: the guideline id, or the finding kind. */
export function headingAnchor(body: string): string | undefined {
  const match = HEADING.exec(body.split("\n")[0] ?? "");
  if (match === null) return undefined;
  return match[2] ?? match[3] ?? "observation";
}

/** The reviewer's own finding comment: its marker, or on author-identified hosts its heading. */
export function reviewerComment(signal: {
  body: string;
  path?: string;
  line?: number;
  own?: boolean;
}): { fingerprint: string; parsed?: ParsedComment } | undefined {
  const parsed = parseFindingComment(signal.body);
  const marked = anyMarkerFingerprint(signal.body);
  if (marked !== undefined)
    return { fingerprint: marked, ...(parsed !== undefined ? { parsed } : {}) };
  const anchor = headingAnchor(signal.body);
  if (signal.own !== true || parsed === undefined || anchor === undefined) return undefined;
  return { fingerprint: fingerprintFrom(signal.path ?? "", anchor, signal.line ?? 0), parsed };
}

export function summaryHeading(presentation: Presentation): string {
  return `## ${presentation.displayName}`;
}

export interface SummaryInput {
  findings: readonly Finding[];
  proposals: readonly ProposedGuideline[];
  droppedUncited: number;
  filtered: number;
  gate: GateDecision;
}

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? "" : "s"}`;
}

function severityCounts(findings: readonly Finding[]): [Severity, number][] {
  const counts = new Map<Severity, number>();
  for (const finding of findings)
    counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  return SEVERITIES.flatMap((severity) => {
    const count = counts.get(severity);
    return count === undefined ? [] : [[severity, count] as [Severity, number]];
  });
}

/** "No issues found in this change." or "2 findings: 1 major, 1 minor". */
export function countLine(findings: readonly Finding[]): string {
  if (findings.length === 0) return "No issues found in this change.";
  const parts = severityCounts(findings).map(
    ([severity, count]) => `${String(count)} ${severity.toLowerCase()}`,
  );
  return `${plural(findings.length, "finding")}: ${parts.join(", ")}`;
}

/** "Blocked: 1 major finding must be resolved"; undefined while the gate passes. */
export function blockedLine(input: Pick<SummaryInput, "findings" | "gate">): string | undefined {
  const { gate } = input;
  if (!gate.failed || gate.threshold === "none") return undefined;
  const threshold = gate.threshold;
  const failing = input.findings.filter(
    (finding) => finding.kind === "violation" && meetsThreshold(finding.severity, threshold),
  );
  const counts = severityCounts(failing);
  const [only] = counts;
  if (counts.length === 1 && only !== undefined) {
    const [severity, count] = only;
    return `Blocked: ${plural(count, `${severity.toLowerCase()} finding`)} must be resolved`;
  }
  const parts = counts.map(([severity, count]) => `${String(count)} ${severity.toLowerCase()}`);
  const detail = parts.length === 0 ? "" : ` (${parts.join(", ")})`;
  return `Blocked: ${plural(gate.failing, "finding")}${detail} must be resolved`;
}

function listItem(finding: Finding, presentation: Presentation): string {
  return `- **${severityWord(finding.severity)}** ${citation(finding, presentation)} in \`${finding.file}\` line ${String(finding.line)}: ${finding.title}`;
}

export function renderSummaryBody(
  input: SummaryInput,
  presentation: Presentation = DEFAULT_PRESENTATION,
): string {
  const lines = [summaryHeading(presentation), "", countLine(input.findings)];
  if (input.findings.length > 0) {
    lines.push("", ...input.findings.map((finding) => listItem(finding, presentation)));
  }
  const blocked = blockedLine(input);
  if (blocked !== undefined) {
    lines.push("", `**${blocked}.**`);
    const guide =
      presentation.guidePath === undefined
        ? undefined
        : presentation.fileLink?.(presentation.guidePath);
    if (guide !== undefined) {
      lines.push(
        "",
        `How reviews work and how to respond: [${String(presentation.guidePath)}](${guide})`,
      );
    }
  }
  if (input.proposals.length > 0) {
    lines.push("", "### Proposed guidelines", "");
    for (const proposal of input.proposals) {
      lines.push(
        `- \`${proposal.id}\` (${severityWord(proposal.severity).toLowerCase()}): ${proposal.rationale}`,
      );
    }
  }
  if (input.filtered > 0 || input.droppedUncited > 0) {
    lines.push(
      "",
      `_Not posted: ${plural(input.filtered, "low-confidence finding")}, ${plural(input.droppedUncited, "finding")} citing no guideline._`,
    );
  }
  if (presentation.markers) lines.push("", SUMMARY_MARKER);
  return lines.join("\n");
}
