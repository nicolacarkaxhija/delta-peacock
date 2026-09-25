import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SEVERITIES } from "../domain/severity.js";
import { ToolError } from "../errors.js";

const Location = {
  file: z.string().min(1),
  line: z.number().int().positive(),
  /** Last line of the span a finding may anchor to; defaults to line. */
  endLine: z.number().int().positive().optional(),
  guidelineId: z.string().min(1).optional(),
  /** The human judgement behind the entry, shown when it fails. */
  why: z.string().optional(),
};

const ExpectedFindingSchema = z.strictObject({
  ...Location,
  severity: z.enum(SEVERITIES).optional(),
  /** Each must appear in the finding's title, body or suggestion, case insensitive. */
  mustMention: z.array(z.string().min(1)).optional(),
  /** None may appear in the finding's suggestion, case insensitive. */
  mustNotSuggest: z.array(z.string().min(1)).optional(),
});

const NoFindingSchema = z.strictObject(Location);

const ExpectedFileSchema = z.strictObject({
  findings: z.array(ExpectedFindingSchema),
  /** Lines a reviewer flagged before and a human judged wrong. */
  noFinding: z.array(NoFindingSchema).default([]),
});

export type ExpectedFinding = z.infer<typeof ExpectedFindingSchema>;
export type NoFinding = z.infer<typeof NoFindingSchema>;

export interface BacktestCase {
  name: string;
  dir: string;
  /** The target tree at review time, guidelines and config included. */
  baseDir: string;
  /** The pull request's change against that tree. */
  diffPath: string;
  expected: ExpectedFinding[];
  noFinding: NoFinding[];
}

function readExpected(file: string): { findings: ExpectedFinding[]; noFinding: NoFinding[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new ToolError(`${file}: not valid JSON (${(error as Error).message})`);
  }
  const parsed = ExpectedFileSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "expected"}: ${issue.message}`,
    );
    throw new ToolError(`${file}: ${problems.join("; ")}`);
  }
  return parsed.data;
}

/**
 * A case is a folder holding base/ (the target tree as the review saw it),
 * diff.patch (the pull request) and expected.json (the human judgement).
 */
export function loadBacktestCases(casesDir: string, only?: readonly string[]): BacktestCase[] {
  if (!existsSync(casesDir) || !statSync(casesDir).isDirectory()) {
    throw new ToolError(`backtest cases directory not found: ${casesDir}`);
  }
  const cases: BacktestCase[] = [];
  for (const entry of readdirSync(casesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(casesDir, entry.name);
    const diffPath = path.join(dir, "diff.patch");
    if (!existsSync(diffPath)) continue;
    if (only !== undefined && !only.includes(entry.name)) continue;
    const baseDir = path.join(dir, "base");
    if (!existsSync(baseDir)) throw new ToolError(`${entry.name}: base/ is missing`);
    const expectedPath = path.join(dir, "expected.json");
    if (!existsSync(expectedPath)) {
      throw new ToolError(`${entry.name}: expected.json is missing; a case needs its judgement`);
    }
    const expected = readExpected(expectedPath);
    cases.push({
      name: entry.name,
      dir,
      baseDir,
      diffPath,
      expected: expected.findings,
      noFinding: expected.noFinding,
    });
  }
  const missing = (only ?? []).filter((name) => !cases.some((one) => one.name === name));
  if (missing.length > 0) throw new ToolError(`no such backtest case: ${missing.join(", ")}`);
  if (cases.length === 0) {
    throw new ToolError(`no cases found under ${casesDir}; a case holds base/ and diff.patch`);
  }
  return cases.sort((a, b) => a.name.localeCompare(b.name));
}
