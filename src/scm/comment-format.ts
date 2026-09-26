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
  /** The host's own severity words; absent means the reviewer's scale. */
  severityScale?: SeverityScale;
}

/** A host's name for each review severity, upper case; the gate keeps the review scale. */
export type SeverityScale = Readonly<Record<Severity, string>>;

export const DEFAULT_PRESENTATION: Presentation = {
  displayName: DEFAULT_DISPLAY_NAME,
  markers: true,
  suggestionFence: "suggestion",
  guidelinesDir: "guidelines",
};

/** "Major", or the host's word for it: "High" on Bitbucket. */
export function severityWord(
  severity: Severity,
  presentation: Pick<Presentation, "severityScale"> = DEFAULT_PRESENTATION,
): string {
  const word = presentation.severityScale?.[severity] ?? severity;
  return `${word.charAt(0)}${word.slice(1).toLowerCase()}`;
}

const lowerWord = (severity: Severity, presentation: Pick<Presentation, "severityScale">) =>
  severityWord(severity, presentation).toLowerCase();

/** Host words read back into the review scale; a shared word keeps its review meaning. */
const HOST_WORDS: Readonly<Record<string, Severity>> = {
  High: "MAJOR",
  Medium: "MINOR",
  Low: "INFO",
};

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
    `**${severityWord(finding.severity, presentation)}** · ${citation(finding, presentation)}`,
    "",
    reason,
  ];
  if (finding.suggestion !== undefined) {
    lines.push("", `\`\`\`${presentation.suggestionFence}`, finding.suggestion, "```");
  }
  if (finding.note !== undefined) lines.push("", `_${finding.note}_`);
  if (presentation.markers) lines.push("", `<!-- delta-peacock:finding:${fingerprint} -->`);
  return lines.join("\n");
}

const HEADING =
  /^\*\*(Blocker|Critical|Major|Minor|Info|High|Medium|Low)\*\* · (?:\[([^\]\s]+)\]\([^)\s]*\)|`([^`\s]+)`|(observation))$/;
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
      severity: HOST_WORDS[String(current[1])] ?? (String(current[1]).toUpperCase() as Severity),
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

/** The heading 0.1.5 and 0.1.6 summaries opened with; only read back, never written. */
export function summaryHeading(presentation: Presentation): string {
  return `## ${presentation.displayName}`;
}

/**
 * What a run amounts to. Every outcome renders through the same summary
 * template; only the state line differs.
 */
export type ReviewOutcome =
  | { kind: "reviewed" }
  /** Nothing was reviewed, for a reason that is not a fault. */
  | { kind: "not-reviewed"; line: string }
  /** The review broke off; the pull request must not read as reviewed. */
  | { kind: "failed"; reason: string }
  /** A cost cap stopped the review before any model call. */
  | { kind: "capped"; reason: string };

/** Why nothing was reviewed; each is the whole state line of its summary. */
export const NOT_REVIEWED = {
  nothingInScope: "Nothing in scope was changed.",
  noGuidelines: "No guidelines were found to review against.",
  noneApply: "No guideline applies to the changed files.",
  tooLarge: "The change is too large to review.",
} as const;

export const NO_ISSUES = "No issues found in this change.";
const FAILED_LEAD = "The review could not complete: ";
const CAPPED_LEAD = "The review was skipped: ";
const COUNT_LEAD = /^\d+ findings?: [a-z0-9, ]+$/;

/**
 * The reviewer's own summary, by its first line: a state line this template
 * writes, or the heading an earlier version wrote. Hosts without markers pair
 * this with the author, so a person's comment never matches.
 */
export function isSummaryBody(body: string, presentation: Presentation): boolean {
  const first = String(body.split("\n")[0]);
  return (
    first === summaryHeading(presentation) ||
    first === NO_ISSUES ||
    first.startsWith(FAILED_LEAD) ||
    first.startsWith(CAPPED_LEAD) ||
    COUNT_LEAD.test(first) ||
    Object.values(NOT_REVIEWED).some((line) => line === first)
  );
}

export interface SummaryInput {
  findings: readonly Finding[];
  proposals: readonly ProposedGuideline[];
  droppedUncited: number;
  filtered: number;
  gate: GateDecision;
  /** Absent means reviewed. */
  outcome?: ReviewOutcome;
  /** How many changed files the review covered, for the commit status. */
  changedFiles?: number;
}

const sentence = (text: string): string => `${text.replace(/[.\s]+$/, "")}.`;

/** The one line that says how the run ended. */
export function stateLine(
  input: Pick<SummaryInput, "findings" | "outcome">,
  presentation: Pick<Presentation, "severityScale"> = DEFAULT_PRESENTATION,
): string {
  const outcome = input.outcome ?? { kind: "reviewed" };
  if (outcome.kind === "not-reviewed") return outcome.line;
  if (outcome.kind === "failed") return `${FAILED_LEAD}${sentence(outcome.reason)}`;
  if (outcome.kind === "capped") return `${CAPPED_LEAD}${sentence(outcome.reason)}`;
  return countLine(input.findings, presentation);
}

/** Room a host leaves for a status description; Bitbucket and GitHub cut near here. */
const STATUS_MAX = 140;

function clip(text: string): string {
  return text.length <= STATUS_MAX ? text : `${text.slice(0, STATUS_MAX - 3).trimEnd()}...`;
}

/**
 * The commit status description: a verdict word first, then one plain line.
 * "Passed. No findings in 4 changed files." or "3 findings, 1 major. See the comments."
 */
export function statusLine(
  input: Pick<SummaryInput, "findings" | "outcome" | "changedFiles">,
  presentation: Pick<Presentation, "severityScale"> = DEFAULT_PRESENTATION,
): string {
  const outcome = input.outcome ?? { kind: "reviewed" };
  if (outcome.kind === "failed") {
    return clip(`Failed. The review could not complete: ${sentence(outcome.reason)}`);
  }
  if (outcome.kind === "capped") return clip(`Skipped. ${sentence(outcome.reason)}`);
  if (outcome.kind === "not-reviewed") {
    if (outcome.line === NOT_REVIEWED.tooLarge)
      return "Skipped. The change is too large to review.";
    if (outcome.line === NOT_REVIEWED.noGuidelines) {
      return "Passed. No guidelines to review against.";
    }
    return "Passed. No reviewable files in this change.";
  }
  if (input.findings.length === 0) {
    return input.changedFiles === undefined
      ? "Passed. No findings in this change."
      : `Passed. No findings in ${plural(input.changedFiles, "changed file")}.`;
  }
  const major = input.findings.filter((finding) => meetsThreshold(finding.severity, "MAJOR"));
  return `${plural(input.findings.length, "finding")}, ${String(major.length)} ${lowerWord("MAJOR", presentation)}. See the comments.`;
}

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? "" : "s"}`;
}

/** Counts per displayed word, most severe first; review severities a host merges count once. */
export function severityCounts(
  findings: readonly Finding[],
  presentation: Pick<Presentation, "severityScale"> = DEFAULT_PRESENTATION,
): [string, number][] {
  const counts = new Map<string, number>();
  for (const severity of SEVERITIES) {
    const count = findings.filter((finding) => finding.severity === severity).length;
    if (count === 0) continue;
    const word = lowerWord(severity, presentation);
    counts.set(word, (counts.get(word) ?? 0) + count);
  }
  return [...counts];
}

/** "No issues found in this change." or "2 findings: 1 major, 1 minor". */
export function countLine(
  findings: readonly Finding[],
  presentation: Pick<Presentation, "severityScale"> = DEFAULT_PRESENTATION,
): string {
  if (findings.length === 0) return NO_ISSUES;
  const parts = severityCounts(findings, presentation).map(
    ([word, count]) => `${String(count)} ${word}`,
  );
  return `${plural(findings.length, "finding")}: ${parts.join(", ")}`;
}

/** "Blocked: a major finding must be resolved"; undefined while the gate passes. */
export function blockedLine(
  input: Pick<SummaryInput, "findings" | "gate">,
  presentation: Pick<Presentation, "severityScale"> = DEFAULT_PRESENTATION,
): string | undefined {
  const { gate } = input;
  if (!gate.failed || gate.threshold === "none") return undefined;
  const threshold = gate.threshold;
  const failing = input.findings.filter(
    (finding) => finding.kind === "violation" && meetsThreshold(finding.severity, threshold),
  );
  const counts = severityCounts(failing, presentation);
  const [only] = counts;
  if (counts.length === 1 && only !== undefined) {
    const [word, count] = only;
    const what =
      count === 1
        ? `${/^[aeiou]/.test(word) ? "an" : "a"} ${word} finding`
        : `${String(count)} ${word} findings`;
    return `Blocked: ${what} must be resolved`;
  }
  const parts = counts.map(([word, count]) => `${String(count)} ${word}`);
  const detail = parts.length === 0 ? "" : ` (${parts.join(", ")})`;
  return `Blocked: ${plural(gate.failing, "finding")}${detail} must be resolved`;
}

function listItem(finding: Finding, presentation: Presentation): string {
  const head = `- **${severityWord(finding.severity, presentation)}** ${citation(finding, presentation)} in \`${finding.file}\``;
  if (finding.unplaced === true) {
    return `${head}: ${finding.title.replace(/[.\s]+$/, "")}. ${String(finding.note)}`;
  }
  return `${head} line ${String(finding.line)}: ${finding.title}`;
}

export function renderSummaryBody(
  input: SummaryInput,
  presentation: Presentation = DEFAULT_PRESENTATION,
): string {
  // no heading: the author, the status and the card already name the reviewer
  const lines = [stateLine(input, presentation)];
  if (input.outcome?.kind === "failed") {
    lines.push("", "Nothing was reviewed on this run. Run the pipeline again to retry.");
  }
  if (input.outcome?.kind === "capped") {
    lines.push("", "Nothing was reviewed on this run. The cost caps are set in the review config.");
  }
  if (input.findings.length > 0) {
    lines.push("", ...input.findings.map((finding) => listItem(finding, presentation)));
  }
  const blocked = blockedLine(input, presentation);
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
        `- \`${proposal.id}\` (${lowerWord(proposal.severity, presentation)}): ${proposal.rationale}`,
      );
    }
  }
  const unposted = [
    ...(input.filtered > 0 ? [plural(input.filtered, "low-confidence finding")] : []),
    ...(input.droppedUncited > 0
      ? [`${plural(input.droppedUncited, "finding")} citing no guideline`]
      : []),
  ];
  if (unposted.length > 0) lines.push("", `_Not posted: ${unposted.join(", ")}._`);
  if (presentation.markers) lines.push("", SUMMARY_MARKER);
  return lines.join("\n");
}
