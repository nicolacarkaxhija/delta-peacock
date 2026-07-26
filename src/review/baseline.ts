import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Finding } from "../domain/finding.js";
import { ToolError } from "../errors.js";
import { fingerprintEntries } from "../scm/publish.js";

export const DEFAULT_BASELINE_PATH = "delta-peacock.baseline.json";

/** One accepted legacy finding; committed, so reviewers can read and prune it. */
export interface BaselineEntry {
  fingerprint: string;
  guidelineId?: string;
  file: string;
  line: number;
  title: string;
  note: string;
}

/**
 * 2 since the observation fingerprint scheme changed to file + line + kind
 * (previously file + line + title): a baseline written under version 1 keys
 * an observation by its freeform title, so its fingerprints no longer match
 * and it churns back to fresh once. Violations are unaffected — their key
 * is still the cited guideline. `loadBaseline` reads either version; the
 * number is a signal for humans and tooling, not an enforced gate.
 */
interface BaselineFile {
  version: 1 | 2;
  entries: BaselineEntry[];
}

export function loadBaseline(cwd: string, relPath: string): Map<string, BaselineEntry> {
  const full = path.resolve(cwd, relPath);
  if (!existsSync(full)) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(full, "utf8"));
  } catch (error) {
    throw new ToolError(`baseline at ${relPath} is not valid JSON: ${(error as Error).message}`);
  }
  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    throw new ToolError(`baseline at ${relPath} holds no entries array`);
  }
  const map = new Map<string, BaselineEntry>();
  for (const entry of entries) {
    const record = entry as Partial<BaselineEntry>;
    if (typeof record.fingerprint !== "string") {
      throw new ToolError(`baseline at ${relPath} holds an entry without a fingerprint`);
    }
    map.set(record.fingerprint, {
      fingerprint: record.fingerprint,
      ...(typeof record.guidelineId === "string" ? { guidelineId: record.guidelineId } : {}),
      file: typeof record.file === "string" ? record.file : "",
      line: typeof record.line === "number" ? record.line : 0,
      title: typeof record.title === "string" ? record.title : "",
      note: typeof record.note === "string" ? record.note : "",
    });
  }
  return map;
}

export function writeBaseline(cwd: string, relPath: string, findings: readonly Finding[]): number {
  const file: BaselineFile = {
    version: 2,
    entries: fingerprintEntries(findings).map(({ fingerprint, finding }) => ({
      fingerprint,
      ...(finding.kind === "violation" ? { guidelineId: finding.guidelineId } : {}),
      file: finding.file,
      line: finding.line,
      title: finding.title,
      note: "accepted as pre-existing; delete this entry to make it gate again",
    })),
  };
  writeFileSync(path.resolve(cwd, relPath), `${JSON.stringify(file, null, 2)}\n`);
  return file.entries.length;
}

export interface BaselineSplit {
  fresh: Finding[];
  baselined: Finding[];
}

/** Baselined findings inform (report) but never gate and never post. */
export function splitByBaseline(
  findings: readonly Finding[],
  baseline: ReadonlyMap<string, BaselineEntry>,
): BaselineSplit {
  const fresh: Finding[] = [];
  const baselined: Finding[] = [];
  for (const { fingerprint, finding } of fingerprintEntries(findings)) {
    (baseline.has(fingerprint) ? baselined : fresh).push(finding);
  }
  return { fresh, baselined };
}
