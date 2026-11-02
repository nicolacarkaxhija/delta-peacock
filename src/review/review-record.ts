import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runGit } from "../git/git.js";

/** Local run state, never committed: one folder per review that wrote a findings file. */
const REVIEWS_DIR = ".delta-peacock-cache/reviews";
const RECORD_FILE = "review.json";
const PATCH_FILE = "diff.patch";
const RECORD_SCHEMA = "review-record-1";
const COMMIT = /^[0-9a-f]{40,64}$/;

/** What a backtest case needs of a review: the commit the change applies to, and the change. */
export interface ReviewRecord {
  base: string;
  patch: string;
  /** The fingerprints of the findings the review wrote. */
  fingerprints: string[];
}

/**
 * Records the change a review saw and returns the record's path from cwd, the evidence its
 * findings name; undefined when the target is not in the clone, as on the SCM API fallback.
 */
export function writeReviewRecord(
  cwd: string,
  change: { staged: boolean; target: string; since?: string | undefined },
  at: Date,
  _contents: { fingerprints: readonly string[]; redact: (text: string) => string } = {
    fingerprints: [],
    redact: (text) => text,
  },
): string | undefined {
  void _contents;
  let base: string;
  let patch: string;
  try {
    if (change.staged) {
      base = runGit(cwd, ["rev-parse", "HEAD"]).trim();
      patch = runGit(cwd, ["diff", "--cached", "--binary", "--no-color"]);
    } else {
      base = runGit(cwd, ["merge-base", change.since ?? change.target, "HEAD"]).trim();
      patch = runGit(cwd, ["diff", "--binary", "--no-color", base, "HEAD"]);
    }
  } catch {
    return undefined;
  }
  const dir = `${REVIEWS_DIR}/${at.toISOString().replace(/[:.]/g, "-")}`;
  mkdirSync(path.join(cwd, dir), { recursive: true });
  writeFileSync(path.join(cwd, dir, PATCH_FILE), patch);
  const record = { schema: RECORD_SCHEMA, at: at.toISOString(), base };
  writeFileSync(path.join(cwd, dir, RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
  return `${dir}/${RECORD_FILE}`;
}

/** The record a finding's evidence names under the records folder, or undefined when it is missing or of another shape. */
export function readReviewRecord(cwd: string, evidence: string): ReviewRecord | undefined {
  const file = path.resolve(cwd, evidence);
  const records = `${path.resolve(cwd, REVIEWS_DIR)}${path.sep}`;
  if (!file.startsWith(records) || !existsSync(file)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  const record = value as { schema?: unknown; base?: unknown };
  if (record.schema !== RECORD_SCHEMA || typeof record.base !== "string") return undefined;
  if (!COMMIT.test(record.base)) return undefined;
  const patchFile = path.join(path.dirname(file), PATCH_FILE);
  if (!existsSync(patchFile)) return undefined;
  return { base: record.base, patch: readFileSync(patchFile, "utf8"), fingerprints: [] };
}
