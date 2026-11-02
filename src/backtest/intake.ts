import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ToolError } from "../errors.js";
import { FINDINGS_PRODUCER } from "../review/findings-file.js";
import { readReviewRecord, type ReviewRecord } from "../review/review-record.js";

/** The file the engine writes when a person marks a finding as a false positive; extra keys pass. */
const FalsePositiveSchema = z.object({
  schema: z.literal("finding-backtest-1"),
  fingerprint: z.string().regex(/^[0-9a-f]{16,64}$/),
  reason: z.string().min(1),
  at: z.string(),
  finding: z.object({
    producer: z.string(),
    rule: z.string().min(1),
    file: z.string().min(1),
    range: z.object({
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive().optional(),
    }),
    evidence: z.string().optional(),
  }),
});

type FalsePositive = z.infer<typeof FalsePositiveSchema>;

export interface IntakeOutcome {
  /** The false positive file, as the intake folder was given. */
  file: string;
  /** The case it became. */
  case?: string;
  /** Why it did not become one. */
  skipped?: string;
}

function readFalsePositive(file: string): FalsePositive | undefined {
  try {
    return FalsePositiveSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return undefined;
  }
}

/** The tree of the base commit, written into dir through an index of its own. */
function checkoutBase(cwd: string, base: string, dir: string): boolean {
  const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, ".intake-index") };
  mkdirSync(dir, { recursive: true });
  const steps = [
    ["read-tree", base],
    ["checkout-index", "-a", `--prefix=${dir}${path.sep}`],
  ];
  const ok = steps.every((args) => spawnSync("git", args, { cwd, env }).status === 0);
  rmSync(env.GIT_INDEX_FILE, { force: true });
  return ok;
}

function writeCase(
  dir: string,
  source: string,
  falsePositive: FalsePositive,
  record: ReviewRecord,
): void {
  const { finding } = falsePositive;
  const { startLine, endLine } = finding.range;
  const noFinding = {
    file: finding.file,
    line: startLine,
    ...(endLine !== undefined ? { endLine } : {}),
    ...(finding.rule !== "observation" ? { guidelineId: finding.rule } : {}),
    why: falsePositive.reason,
  };
  const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path.join(dir, "diff.patch"), record.patch);
  writeFileSync(
    path.join(dir, "expected.json"),
    json({ findings: [], noFinding: [noFinding], othersUnjudged: true }),
  );
  const origin = {
    from: source,
    fingerprint: falsePositive.fingerprint,
    at: falsePositive.at,
    evidence: finding.evidence,
  };
  writeFileSync(path.join(dir, "case.json"), json(origin));
}

/** One false positive file: the case it became, or why it was skipped. */
function intakeOne(cwd: string, source: string, casesDir: string): IntakeOutcome {
  const falsePositive = readFalsePositive(path.resolve(cwd, source));
  if (falsePositive === undefined) return { file: source, skipped: "not a false positive file" };
  const { finding } = falsePositive;
  if (finding.producer !== FINDINGS_PRODUCER) {
    return { file: source, skipped: "not a reviewer finding" };
  }
  const name = `false-positive-${falsePositive.fingerprint}`;
  const dir = path.join(casesDir, name);
  if (existsSync(dir)) return { file: source, skipped: "already a backtest case" };
  if (finding.evidence === undefined) {
    return { file: source, skipped: "no review record: the finding names no evidence" };
  }
  const record = readReviewRecord(cwd, finding.evidence);
  if (record === undefined) {
    return { file: source, skipped: `no review record at ${finding.evidence}` };
  }
  if (!checkoutBase(cwd, record.base, path.join(dir, "base"))) {
    rmSync(dir, { recursive: true, force: true });
    return {
      file: source,
      skipped: `the base commit of ${finding.evidence} is not in this clone`,
    };
  }
  writeCase(dir, source, falsePositive, record);
  return { file: source, case: name };
}

/**
 * Turns each false positive file of the reviewer in intakeDir into a backtest case under
 * casesDir: the base commit and patch of the review record its finding names, and the finding's
 * span as a noFinding entry with the person's reason. Run it from the clone the review ran in.
 */
export function intakeFalsePositives(
  cwd: string,
  intakeDir: string,
  casesDir: string,
): IntakeOutcome[] {
  const folder = path.resolve(cwd, intakeDir);
  if (!existsSync(folder)) throw new ToolError(`false positive folder not found: ${intakeDir}`);
  return readdirSync(folder)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => intakeOne(cwd, `${intakeDir}/${name}`, path.resolve(cwd, casesDir)));
}
