import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ToolSet } from "ai";
import {
  loadCases,
  runBench,
  type BenchCase,
  type ReviewFn,
  type ReviewResult,
} from "../bench/harness.js";
import type { Finding } from "../domain/finding.js";
import { buildModelPortFor } from "../model/build.js";
import type { ModelUsage } from "../model/port.js";
import { addUsage } from "../model/usage.js";
import { calibrate } from "../review/calibrate.js";
import { runEnsemble } from "../review/ensemble.js";
import type { ParsedReview } from "../review/parse.js";
import { planPasses, runPasses, type PromptOf } from "../review/run-review.js";
import { formatTable } from "../bench/harness.js";
import { overlapMatrix, type ProducedFinding } from "../bench/scoring.js";
import { attachContextTools, resolveContext } from "../context/build.js";
import { checkCostGuard, guardActive } from "../cost/guard.js";
import type { RuntimeDeps } from "../deps.js";
import { changedFilesFromDiff, newLineTexts } from "../git/diff.js";
import {
  dropCommentMoves,
  dropGoodExamples,
  dropUnfitTags,
  linesFromDiff,
  placeFindings,
} from "../review/placement.js";
import { readDeclaredTags } from "../review/declared.js";
import { loadGuidelinesFromFiles, readWorkingTreeGuidelines } from "../guidelines/loader.js";
import { buildModelPort } from "../model/build.js";
import { buildPromptOptions, buildReviewPrompt } from "../review/prompt.js";
import { readSourceForStructuralCheck } from "../review/run-review.js";
import { verifyStructural } from "../review/structural.js";

/**
 * Each case is self-contained: its own guidelines, its own optional files/
 * tree for context strategies, no git required. The same pipeline pieces
 * that review PRs judge the cases, so bench results transfer.
 */
/** A case's own guidelines/, else the corpus-wide bench/guidelines next to the cases dir. */
export function guidelinesDirFor(caseDir: string): string {
  const own = path.join(caseDir, "guidelines");
  return existsSync(own) ? own : path.join(caseDir, "..", "..", "guidelines");
}

function addTo(
  usage: Record<string, ModelUsage>,
  model: string,
  add: ModelUsage | undefined,
): void {
  if (add === undefined) return;
  const had = usage[model];
  usage[model] = had === undefined ? add : addUsage(had, add);
}

function reviewFnFrom(deps: RuntimeDeps, flags: Readonly<Record<string, string>>): ReviewFn {
  return async (benchCase: BenchCase): Promise<ReviewResult> => {
    const config = deps.loadConfig(flags);
    const guidelines = loadGuidelinesFromFiles(
      readWorkingTreeGuidelines(guidelinesDirFor(benchCase.dir)),
      config.review.frontmatterContract,
    ).guidelines;

    const filesRoot = path.join(benchCase.dir, "files");
    const changedFiles = changedFilesFromDiff(benchCase.diff);
    let projectContext = "";
    let contextTools: ToolSet | undefined;
    if (existsSync(filesRoot)) {
      // the same resolution path a live review takes: systemContext AND
      // tools, never just the former (that gap once left an agentic bench
      // run with no file access at all while scoring as if it had one)
      const resolved = await resolveContext(
        config,
        {
          credentials: deps.credentials,
          ...(deps.embeddingPort ? { embeddingPort: deps.embeddingPort } : {}),
        },
        { cwd: filesRoot, diff: benchCase.diff, changedFiles },
      );
      for (const notice of resolved.notices) deps.err(`${notice}\n`);
      projectContext = resolved.projectContext;
      contextTools = resolved.tools;
    }

    // files/ is the case's repository root: its declared tags and linters count
    const promptOptions = buildPromptOptions(
      config,
      existsSync(filesRoot) ? filesRoot : benchCase.dir,
      projectContext,
    );
    const promptOf: PromptOf = (diffText) => buildReviewPrompt(guidelines, diffText, promptOptions);
    // the same call a live review plans for a one batch diff
    const passes = planPasses(config, [benchCase.diff], [projectContext], contextTools, promptOf);
    const request = attachContextTools(
      promptOf(benchCase.diff, projectContext),
      contextTools,
      config.context.maxToolRounds,
    );

    // the same pre-flight gate a live review applies, scoped to this one
    // case: a blocked case scores as "nothing produced" rather than aborting
    // the whole corpus run, so DELTA_PEACOCK_COST_MAX_PER_REVIEW still bites
    // on the command meant to be run repeatedly, without making one capped
    // case take the rest of the corpus down with it
    if (guardActive(config)) {
      const now = deps.clock?.() ?? new Date();
      const decision = await checkCostGuard(config, request, now);
      for (const notice of decision.notices) deps.err(`${notice}\n`);
      if (!decision.allowed) {
        for (const reason of decision.reasons) deps.out(`budget: ${reason}\n`);
        deps.out(`bench: ${benchCase.name} blocked by the cost guard before any model call\n`);
        return { produced: [] };
      }
    }

    const guidelinesById = new Map(guidelines.map((guideline) => [guideline.id, guideline]));
    const parseOptions = {
      guidelinesById,
      generalPass: config.review.generalPass,
      observationSeverityCap: config.review.observationSeverityCap,
    };
    const usage: Record<string, ModelUsage> = {};
    let parsed: ParsedReview;
    if (config.ensemble.enabled) {
      // the same members, union and judge a live review runs
      const ensemble = await runEnsemble(deps, config, request, parseOptions);
      for (const notice of ensemble.notices) deps.err(`${notice}\n`);
      for (const member of ensemble.members) addTo(usage, member.id, member.usage);
      parsed = ensemble.parsed;
    } else {
      const port = deps.modelPort ?? buildModelPort(config, deps.credentials);
      // the passes, retry and merge a live review runs
      const executed = await runPasses(deps, port, passes, parseOptions);
      addTo(usage, config.model.id ?? config.model.provider, executed.usage);
      parsed = executed.parsed;
    }
    // the same placement and Good example gate a live review applies
    const diffLines = newLineTexts(benchCase.diff);
    const linesOf = (file: string): readonly string[] | undefined => {
      const source = readSourceForStructuralCheck(filesRoot, file);
      if (source !== undefined) return source.split("\n");
      const known = diffLines.get(file);
      return known === undefined ? undefined : linesFromDiff(known);
    };
    const placed = placeFindings(parsed.findings, linesOf);
    // the same comment move and Good example gates a live review applies
    const tags = readDeclaredTags(
      existsSync(filesRoot) ? filesRoot : benchCase.dir,
      config.review.repoConfigPath,
    );
    const fitted = dropUnfitTags(dropCommentMoves(placed, linesOf).kept, linesOf, tags).kept;
    const kept = dropGoodExamples(fitted, guidelinesById).kept;
    // same AST gate a live review applies, reading the case's files/ tree
    const structural = verifyStructural(kept, guidelinesById, (file) =>
      readSourceForStructuralCheck(filesRoot, file),
    );
    let findings: Finding[] = structural.kept;
    if (config.calibration.enabled && findings.length > 0) {
      // advisory as in a live review: a drop note is recorded, the finding stays
      const ref = config.calibration.model;
      const calibrationPort = ref
        ? (deps.modelPortFor?.(ref) ?? buildModelPortFor(ref, deps.credentials))
        : (deps.modelPort ?? buildModelPort(config, deps.credentials));
      const outcome = await calibrate(calibrationPort, findings, benchCase.diff);
      findings = outcome.findings;
      addTo(usage, ref?.id ?? config.model.id ?? config.model.provider, outcome.usage);
    }
    return {
      produced: findings.map((finding) => ({
        file: finding.file,
        line: finding.line,
        ...(finding.kind === "violation" ? { guidelineId: finding.guidelineId } : {}),
        ...(finding.suggestion !== undefined ? { suggestion: finding.suggestion } : {}),
        ...(finding.calibration !== undefined ? { calibration: finding.calibration.action } : {}),
      })),
      ...(Object.keys(usage).length > 0 ? { usage } : {}),
      misquoted: parsed.droppedMisquoted,
    };
  };
}

/** A variant like repo_map+agentic layers strategies through context.providers. */
export function contextFlag(variant: string): Record<string, string> {
  if (variant.includes("+")) {
    return {
      "context.providers": variant
        .split("+")
        .map((name) => name.trim())
        .join(","),
    };
  }
  return { "context.provider": variant };
}

function formatMatrix(matrix: Record<string, Record<string, number>>): string {
  const names = Object.keys(matrix);
  const lines = [
    "overlap matrix (shared findings per variant pair):",
    `| | ${names.join(" | ")} |`,
    `| --- |${names.map(() => " --- |").join("")}`,
  ];
  for (const row of names) {
    lines.push(`| ${row} | ${names.map((col) => String(matrix[row]?.[col] ?? 0)).join(" | ")} |`);
  }
  return `${lines.join("\n")}\n`;
}

export async function runBenchCommand(
  deps: RuntimeDeps,
  options: { cases: string; report?: string; contexts?: string[]; minF1?: number },
  flags: Readonly<Record<string, string>>,
): Promise<number> {
  const cases = loadCases(path.resolve(deps.cwd, options.cases));

  if (options.contexts !== undefined && options.contexts.length > 1) {
    // variant comparison: per-variant tables plus the no-ground-truth matrix
    const producedByVariant: Record<string, ProducedFinding[]> = {};
    const outcomes: Record<string, unknown> = {};
    for (const variant of options.contexts) {
      const outcome = await runBench(
        cases,
        reviewFnFrom(deps, { ...flags, ...contextFlag(variant) }),
      );
      deps.out(`\ncontext = ${variant}\n`);
      deps.out(formatTable(outcome));
      outcomes[variant] = outcome;
      producedByVariant[variant] = outcome.cases.flatMap((caseOutcome) =>
        caseOutcome.produced.map((finding) => ({
          ...finding,
          file: `${caseOutcome.name}/${finding.file}`,
        })),
      );
    }
    const matrix = overlapMatrix(producedByVariant);
    deps.out(`\n${formatMatrix(matrix)}`);
    if (options.report !== undefined) {
      writeFileSync(
        path.resolve(deps.cwd, options.report),
        `${JSON.stringify({ variants: outcomes, overlap: matrix }, null, 2)}\n`,
      );
    }
    return 0;
  }

  const outcome = await runBench(cases, reviewFnFrom(deps, flags));
  deps.out(formatTable(outcome));
  if (options.report !== undefined) {
    writeFileSync(path.resolve(deps.cwd, options.report), `${JSON.stringify(outcome, null, 2)}\n`);
  }
  // a quality gate for CI: a live smoke run fails when the corpus regresses
  if (
    options.minF1 !== undefined &&
    outcome.aggregate !== undefined &&
    outcome.aggregate.f1 < options.minF1
  ) {
    const pct = (value: number): string => `${(value * 100).toFixed(0)}%`;
    deps.err(
      `bench: aggregate f1 ${pct(outcome.aggregate.f1)} is below the --min-f1 threshold ${pct(options.minF1)}\n`,
    );
    return 1;
  }
  return 0;
}
