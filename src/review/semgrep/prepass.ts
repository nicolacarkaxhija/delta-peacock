import picomatch from "picomatch";
import type { Violation } from "../../domain/finding.js";
import type { Guideline, SemgrepCheck } from "../../domain/guideline.js";
import { newLineTexts } from "../../git/diff.js";
import { appliesTo } from "../../guidelines/languages.js";
import { withholdSettled, type Withheld } from "./hunks.js";
import { combinedRules } from "./rules.js";
import type { SemgrepRunner } from "./run.js";

export interface PrepassInput {
  /** The guidelines that apply to the change. */
  guidelines: readonly Guideline[];
  diff: string;
  /** A changed file's lines at the reviewed commit. */
  read: (file: string) => readonly string[] | undefined;
  generalPass: boolean;
  runner: SemgrepRunner;
}

export interface PrepassOutcome {
  /** The guidelines the rules decide; the model never judges them. */
  settled: string[];
  findings: Violation[];
  /** The diff the model receives. */
  modelDiff: string;
  withheld: Withheld[];
  notices: string[];
  /** The Semgrep version that ran; absent when nothing ran. */
  engine?: string;
  /** Where each rule set came from: a pack and its version, or local. */
  ruleSets: string[];
  /** Why the run failed; the model then reviews the whole diff. */
  failure?: string;
}

/** The marking of a guideline the model judges as well as its rule. */
const JUDGED = "judged";

type Ruled = Guideline & { check: SemgrepCheck };

const isRuled = (guideline: Guideline): guideline is Ruled => guideline.check?.type === "semgrep";

/** Whether a rule guideline reads the file: its scope and, when it names any, its check's globs. */
function covers(guideline: Ruled, file: string): boolean {
  const { files } = guideline.check;
  return appliesTo(guideline, [file]) && (files.length === 0 || picomatch([...files])(file));
}

/**
 * The semgrep pre pass: the rules every rule guideline carries run over the
 * changed files before the model. A hit on an added line is a finding; a hunk
 * it lands in is withheld from the model when no guideline the model judges
 * covers the file. A failed run settles nothing, so the model sees everything.
 * Undefined when no guideline declares a semgrep check.
 */
export async function runPrepass(input: PrepassInput): Promise<PrepassOutcome | undefined> {
  const ruled = input.guidelines.filter(isRuled);
  if (ruled.length === 0) return undefined;
  const ruleSets = [
    ...new Set(
      ruled.map((guideline) =>
        guideline.pack === undefined
          ? "local"
          : `${guideline.pack} ${guideline.check.version ?? "unversioned"}`,
      ),
    ),
  ];
  const changed = newLineTexts(input.diff);
  const targets = new Map<string, string>();
  for (const file of changed.keys()) {
    if (!ruled.some((guideline) => covers(guideline, file))) continue;
    const lines = input.read(file);
    if (lines !== undefined) targets.set(file, lines.join("\n"));
  }
  const settled = ruled
    .filter((guideline) => !guideline.tags.includes(JUDGED))
    .map((guideline) => guideline.id);
  const untouched = { modelDiff: input.diff, withheld: [], ruleSets };
  if (targets.size === 0) return { settled, findings: [], notices: [], ...untouched };

  const { config, owners } = combinedRules(ruled);
  const run = await input.runner(config, targets);
  if (!run.ok) {
    return { settled: [], findings: [], notices: [], failure: run.reason, ...untouched };
  }
  const findings: Violation[] = [];
  const settledLines = new Map<string, Set<number>>();
  const seen = new Set<string>();
  let offChange = 0;
  for (const hit of run.hits) {
    const owner = owners.get(hit.ruleId);
    if (owner === undefined || !covers(owner.guideline as Ruled, hit.path)) continue;
    const added = changed.get(hit.path) ?? new Map<number, string>();
    const lines = [...added.keys()].filter((line) => line >= hit.startLine && line <= hit.endLine);
    const first = lines[0];
    if (first === undefined) {
      offChange += 1;
      continue;
    }
    const onFile = settledLines.get(hit.path) ?? new Set<number>();
    for (const line of lines) onFile.add(line);
    settledLines.set(hit.path, onFile);
    const key = `${owner.guideline.id}\0${hit.path}\0${String(first)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { message } = (owner.guideline as Ruled).check;
    findings.push({
      kind: "violation",
      producer: "semgrep",
      guidelineId: owner.guideline.id,
      ...(owner.guideline.pack !== undefined ? { pack: owner.guideline.pack } : {}),
      severity: owner.guideline.severity,
      file: hit.path,
      line: first,
      title: message,
      body: `Matched by the semgrep rule ${owner.rule}.`,
      quote: String(added.get(first)),
      guidelineQuote: message,
    });
  }
  const judged = input.guidelines.filter((guideline) => !settled.includes(guideline.id));
  const left = withholdSettled(
    input.diff,
    settledLines,
    (file) => !input.generalPass && !judged.some((guideline) => appliesTo(guideline, [file])),
  );
  return {
    settled,
    findings,
    modelDiff: left.diff,
    withheld: left.withheld,
    notices: [
      ...(offChange > 0 ? [`semgrep: ${String(offChange)} hit(s) off the change`] : []),
      ...run.warnings.map((warning) => `semgrep: ${warning}`),
    ],
    engine: run.version,
    ruleSets,
  };
}
