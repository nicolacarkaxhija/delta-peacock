import { DEFAULT_DISPLAY_NAME, type Config } from "../config/schema.js";
import { fingerprintFrom, type Finding, type ProposedGuideline } from "../domain/finding.js";
import type { GateDecision } from "../domain/gate.js";
import { meetsThreshold, SEVERITIES, type Severity } from "../domain/severity.js";
import type { ModelUnavailability } from "../model/unavailable.js";

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
  /** Web link to a guideline's file; undefined where the host has none or the file is unknown. */
  guidelineLink?: (guidelineId: string) => string | undefined;
  /** Web link to where a finding sits: its comment, or its file and line; undefined where the host has none. */
  placeLink?: (finding: Finding) => string | undefined;
  /** Web link to a repository file at the reviewed commit. */
  reviewedFileLink?: (path: string) => string;
  /** Web link to a commit. */
  commitLink?: (sha: string) => string;
  guidelinesDir: string;
  /** Repository doc on how reviews work, named by a blocked summary. */
  guidePath?: string;
  /** False when the doc is not on the target branch yet, so it is named without a link. */
  guideLinked?: boolean;
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

/** What linking a guideline needs from a presentation. */
export type LinkSource = Pick<Presentation, "fileLink" | "guidelineLink" | "guidelinesDir">;

export function guidelineUrl(guidelineId: string, presentation: LinkSource): string | undefined {
  if (presentation.guidelineLink !== undefined) return presentation.guidelineLink(guidelineId);
  return presentation.fileLink?.(`${presentation.guidelinesDir}/${guidelineId}.md`);
}

function citation(finding: Finding, presentation: Presentation): string {
  if (finding.kind !== "violation") return "observation";
  // a pack guideline lives outside this repository, so it has no link here
  const url =
    finding.pack === undefined ? guidelineUrl(finding.guidelineId, presentation) : undefined;
  return url === undefined ? `\`${finding.guidelineId}\`` : `[${finding.guidelineId}](${url})`;
}

/** A heading citing a guideline gets the guideline's current link, where there is one. */
export function linkedHeading(heading: string, presentation: LinkSource): string {
  const match = HEADING.exec(heading);
  const id = match?.[2] ?? match?.[3];
  if (match === null || id === undefined) return heading;
  const url = guidelineUrl(id, presentation);
  return url === undefined ? heading : `**${String(match[1])}** · [${id}](${url})`;
}

/** The first two sentences; a sentence ends at . ! or ? followed by space and a capital. */
export function twoSentences(text: string): string {
  const flat = text.trim().replace(/\s+/g, " ");
  const sentences = flat.split(/(?<=[.!?])\s+(?=[A-Z`*"'(])/);
  return sentences.slice(0, 2).join(" ");
}

/** "Guideline: <the sentence the finding applies>"; undefined when it quotes none. */
export function guidelineLine(finding: Finding): string | undefined {
  if (finding.kind !== "violation" || finding.guidelineQuote === undefined) return undefined;
  const quote = finding.guidelineQuote.trim().replace(/\s+/g, " ");
  return quote === "" ? undefined : `Guideline: ${quote}`;
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
  const rule = guidelineLine(finding);
  if (rule !== undefined) lines.push("", rule);
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
    first.startsWith(FACTS_LEAD) ||
    first.startsWith(FALLBACK_LEAD) ||
    first.startsWith(PARTIAL_LEAD) ||
    COUNT_LEAD.test(first) ||
    Object.values(NOT_REVIEWED).some((line) => line === first)
  );
}

export interface SummaryInput {
  findings: readonly Finding[];
  proposals: readonly ProposedGuideline[];
  droppedUncited: number;
  /** Model findings on no added or edited line of the change. */
  droppedOffChange?: number;
  filtered: number;
  gate: GateDecision;
  /** Absent means reviewed. */
  outcome?: ReviewOutcome;
  /** How many changed files the review covered, for the commit status. */
  changedFiles?: number;
  /** Set when no model ran: what the facts only review left out. */
  factsOnly?: FactsScope;
}

/** What a run with no model left out: candidates for a person, guidelines no check owns. */
export interface FactsScope {
  left: number;
  notReviewed: readonly string[];
  /** Set when a configured model could not run: the merge then needs a person's approval. */
  fallback?: ModelUnavailability;
  /** The status a fallback posts when the facts pass; success when unset. */
  fallbackStatus?: Config["fallback"]["status"];
  /** What a model reviewed before it could not run: part of the change, or all of it and only the judge failed. */
  modelReviewed?: "part" | "all";
  /** The files no model reviewed when only part of the change was. */
  unjudgedFiles?: readonly string[];
  /** Earlier findings on the pull request this run could not judge again; their comments stay as they are. */
  notRejudged?: readonly string[];
}

const FACTS_LEAD = "This review checked facts only, with no model: ";
const FALLBACK_LEAD = "The model could not run (";
const PARTIAL_LEAD = "The model reviewed ";

/** Why the model could not run, in the summary's words and the status's short ones. */
const FALLBACK_REASONS: Readonly<Record<ModelUnavailability, { long: string; short: string }>> = {
  "not-configured": { long: "no model is configured", short: "not configured" },
  unreachable: { long: "the model provider could not be reached", short: "unreachable" },
  limit: {
    long: "the model provider answered with a rate or quota limit",
    short: "rate or quota limit",
  },
  timeout: { long: "the model call timed out", short: "timed out" },
  "credential-refused": { long: "the credential was refused", short: "credential refused" },
  "cost-cap": { long: "the review reached its cost cap", short: "cost cap" },
};

/** The success status text of a fallback, by what the model reviewed. */
const FALLBACK_APPROVAL = {
  none: "Facts only, no model: needs a person's approval",
  part: "Model reviewed in part: needs a person's approval",
  all: "Judge could not run: needs a person's approval",
} as const;

/** The short reason a log line and a status give for a model that could not run. */
export function fallbackReason(why: ModelUnavailability): string {
  return FALLBACK_REASONS[why].short;
}

/** How a facts only line names a guideline and a file; plain by default. */
interface FactsNames {
  guideline: (guidelineId: string) => string;
  file: (path: string) => string;
}

const PLAIN_NAMES: FactsNames = { guideline: (id) => id, file: (path) => path };

/** The one sentence a facts only summary opens with. */
export function factsLine(
  findings: number,
  scope: FactsScope,
  names: FactsNames = PLAIN_NAMES,
): string {
  const name = names.guideline;
  const left =
    scope.left === 1
      ? "1 candidate left to a person because it needs a judgement"
      : `${String(scope.left)} candidates left to a person because they need a judgement`;
  const skipped =
    scope.notReviewed.length === 0
      ? "every applicable guideline checked"
      : `${plural(scope.notReviewed.length, "guideline")} not reviewed (${scope.notReviewed.map(name).join(", ")})`;
  const counts = `${plural(findings, "finding")}, ${left}, and ${skipped}.`;
  if (scope.fallback === undefined) return `${FACTS_LEAD}${counts}`;
  const reason = FALLBACK_REASONS[scope.fallback].long;
  const approval = "Merging needs a person's approval.";
  if (scope.modelReviewed === "all") {
    return `${PARTIAL_LEAD}the change, but the judge could not run (${reason}): ${plural(findings, "finding")}, and ${left}. ${approval}`;
  }
  if (scope.modelReviewed === "part") {
    const files = (scope.unjudgedFiles ?? []).map(names.file).join(", ");
    const unchecked =
      scope.notReviewed.length === 0
        ? "every applicable guideline checked"
        : `${plural(scope.notReviewed.length, "guideline")} not reviewed on those files (${scope.notReviewed.map(name).join(", ")})`;
    return `${PARTIAL_LEAD}part of the change, then could not run (${reason}): no model reviewed ${files}, where this review checked facts only. ${plural(findings, "finding")}, ${left}, and ${unchecked}. ${approval}`;
  }
  return `${FALLBACK_LEAD}${reason}), so this review checked facts only: ${counts} ${approval}`;
}

/** The facts only commit status: no verdict word, since no full review ran. */
function factsStatus(findings: number, scope: FactsScope, gate: GateDecision | undefined): string {
  if (scope.fallback !== undefined) {
    const reviewed = scope.modelReviewed ?? "none";
    if (gate?.failed !== true && scope.fallbackStatus !== "pending") {
      return FALLBACK_APPROVAL[reviewed];
    }
    const lead = {
      none: "No model",
      part: "Model in part",
      all: "No judge",
    }[reviewed];
    return clip(
      `${lead} (${fallbackReason(scope.fallback)})${reviewed === "none" ? ", facts only" : ""}: ${plural(findings, "finding")}, ${String(scope.left)} left to a person. Needs a person's approval.`,
    );
  }
  return clip(
    `Facts only, no model. ${plural(findings, "finding")}, ${String(scope.left)} left to a person, ${plural(scope.notReviewed.length, "guideline")} not reviewed.`,
  );
}

const sentence = (text: string): string => `${text.replace(/[.\s]+$/, "")}.`;

/** The one line that says how the run ended. */
export function stateLine(
  input: Pick<SummaryInput, "findings" | "outcome" | "factsOnly">,
  presentation: Pick<Presentation, "severityScale"> = DEFAULT_PRESENTATION,
): string {
  const outcome = input.outcome ?? { kind: "reviewed" };
  if (outcome.kind === "not-reviewed") return outcome.line;
  if (outcome.kind === "failed") return `${FAILED_LEAD}${sentence(outcome.reason)}`;
  if (outcome.kind === "capped") return `${CAPPED_LEAD}${sentence(outcome.reason)}`;
  if (input.factsOnly !== undefined) return factsLine(input.findings.length, input.factsOnly);
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
  input: Pick<SummaryInput, "findings" | "outcome" | "changedFiles" | "factsOnly"> &
    Partial<Pick<SummaryInput, "gate">>,
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
  if (input.factsOnly !== undefined) {
    return factsStatus(input.findings.length, input.factsOnly, input.gate);
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

/** "[file line 3](...)", or "[file](...)" for a finding on no line; code where nothing links. */
function placeText(finding: Finding, presentation: Presentation): string {
  const line = finding.unplaced === true ? undefined : finding.line;
  const url = presentation.placeLink?.(finding);
  const where = line === undefined ? finding.file : `${finding.file} line ${String(line)}`;
  if (url !== undefined) return `[${where}](${url})`;
  return line === undefined ? `\`${finding.file}\`` : `\`${finding.file}\` line ${String(line)}`;
}

function listItem(finding: Finding, presentation: Presentation): string {
  const head = `- **${severityWord(finding.severity, presentation)}** ${citation(finding, presentation)} in ${placeText(finding, presentation)}`;
  if (finding.unplaced === true) {
    return `${head}: ${finding.title.replace(/[.\s]+$/, "")}. ${String(finding.note)}`;
  }
  return `${head}: ${finding.title}`;
}

/** The summary's first line; guideline ids in it link where they can. */
function summaryStateLine(input: SummaryInput, presentation: Presentation): string {
  const reviewed = (input.outcome?.kind ?? "reviewed") === "reviewed";
  if (!reviewed || input.factsOnly === undefined) return stateLine(input, presentation);
  const linked = (text: string, url: string | undefined) =>
    url === undefined ? text : `[${text}](${url})`;
  return factsLine(input.findings.length, input.factsOnly, {
    guideline: (guidelineId) => linked(guidelineId, guidelineUrl(guidelineId, presentation)),
    file: (path) => linked(path, presentation.reviewedFileLink?.(path)),
  });
}

export function renderSummaryBody(
  input: SummaryInput,
  presentation: Presentation = DEFAULT_PRESENTATION,
): string {
  // no heading: the author, the status and the card already name the reviewer
  const lines = [summaryStateLine(input, presentation)];
  if (input.outcome?.kind === "failed") {
    lines.push("", "Nothing was reviewed on this run. Run the pipeline again to retry.");
  }
  if (input.outcome?.kind === "capped") {
    lines.push("", "Nothing was reviewed on this run. The cost caps are set in the review config.");
  }
  if (input.findings.length > 0) {
    lines.push("", ...input.findings.map((finding) => listItem(finding, presentation)));
  }
  const kept = input.factsOnly?.notRejudged ?? [];
  if (kept.length > 0) {
    lines.push(
      "",
      `Not judged again on this run, so their comments stay as they are: ${kept.join(", ")}.`,
    );
  }
  const blocked = blockedLine(input, presentation);
  if (blocked !== undefined) {
    lines.push("", `**${blocked}.**`);
    const { guidePath } = presentation;
    if (guidePath !== undefined) {
      const guide =
        presentation.guideLinked === false ? undefined : presentation.fileLink?.(guidePath);
      const named = guide === undefined ? guidePath : `[${guidePath}](${guide})`;
      lines.push("", `How reviews work and how to respond: ${named}`);
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
    ...((input.droppedOffChange ?? 0) > 0
      ? [`${plural(input.droppedOffChange ?? 0, "finding")} off the change`]
      : []),
  ];
  if (unposted.length > 0) lines.push("", `_Not posted: ${unposted.join(", ")}._`);
  if (presentation.markers) lines.push("", SUMMARY_MARKER);
  return lines.join("\n");
}
