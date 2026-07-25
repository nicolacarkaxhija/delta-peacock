export interface Waiver {
  guidelineId: string;
  file: string;
  /** The new-file line the waiver comment sits on. */
  line: number;
  reason: string;
  /** YYYY-MM-DD; carried for the report, never used for gating (ADR 0008). */
  until?: string;
}

export interface ParsedWaivers {
  waivers: Waiver[];
  /** Waiver-shaped comments with no reason: counted, not returned. */
  malformed: number;
}

const ALLOW = /delta-peacock:allow\s+([A-Za-z0-9._-]+)(.*)$/;
// separator is an em dash, a double dash, or a single dash; an optional trailing
// until=YYYY-MM-DD is captured on its own and never folded into the reason
const REASON = /^\s*(?:—|--|-)\s*(.+?)(?:\s+until=(\d{4}-\d{2}-\d{2}))?\s*$/;

/**
 * Scans line-numbered source (the shape newLineTexts produces: file -> line ->
 * text) for in-code waiver directives. A directive with no reason is malformed:
 * counted, not returned, so it can never silently excuse a finding.
 */
export function parseWaivers(
  lineText: ReadonlyMap<string, ReadonlyMap<number, string>>,
): ParsedWaivers {
  const waivers: Waiver[] = [];
  let malformed = 0;
  for (const [file, lines] of lineText) {
    for (const [line, text] of lines) {
      const allow = ALLOW.exec(text);
      if (allow === null) continue;
      const reasonMatch = REASON.exec(allow[2] ?? "");
      if (reasonMatch === null) {
        malformed += 1;
        continue;
      }
      const guidelineId = allow[1];
      const reason = reasonMatch[1];
      /* v8 ignore next 2 -- both capture groups always match; the guard is for the type checker */
      if (guidelineId === undefined || reason === undefined) continue;
      const until = reasonMatch[2];
      waivers.push({ guidelineId, file, line, reason, ...(until !== undefined ? { until } : {}) });
    }
  }
  return { waivers, malformed };
}

/**
 * A waiver excuses a finding when the file and guideline id match and the
 * finding sits on the waiver's own line. An uncited finding (no guideline id)
 * is never waivable: its undefined id can equal no waiver's.
 */
export function findWaiver(
  finding: { guidelineId?: string; file: string; line: number },
  waivers: readonly Waiver[],
): Waiver | undefined {
  return waivers.find(
    (waiver) =>
      waiver.file === finding.file &&
      waiver.guidelineId === finding.guidelineId &&
      (finding.line === waiver.line || finding.line === waiver.line + 1),
  );
}
