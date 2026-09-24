import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ToolSet } from "ai";
import { loadCases, runBench, type BenchCase, type ReviewFn } from "../bench/harness.js";
import { formatTable } from "../bench/harness.js";
import { overlapMatrix, type ProducedFinding } from "../bench/scoring.js";
import { attachContextTools, resolveContext } from "../context/build.js";
import { checkCostGuard, guardActive } from "../cost/guard.js";
import type { RuntimeDeps } from "../deps.js";
import { changedFilesFromDiff } from "../git/diff.js";
import { loadGuidelinesFromFiles, readWorkingTreeGuidelines } from "../guidelines/loader.js";
import { buildModelPort } from "../model/build.js";
import { parseReviewResponse } from "../review/parse.js";
import { buildPromptOptions, buildReviewPrompt } from "../review/prompt.js";
import { readSourceForStructuralCheck } from "../review/run-review.js";
import { verifyStructural } from "../review/structural.js";

/**
 * Each case is self-contained: its own guidelines, its own optional files/
 * tree for context strategies, no git required. The same pipeline pieces
 * that review PRs judge the cases, so bench results transfer.
 */
function reviewFnFrom(deps: RuntimeDeps, flags: Readonly<Record<string, string>>): ReviewFn {
  return async (benchCase: BenchCase): Promise<ProducedFinding[]> => {
    const config = deps.loadConfig(flags);
    const guidelines = loadGuidelinesFromFiles(
      readWorkingTreeGuidelines(path.join(benchCase.dir, "guidelines")),
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

    const request = attachContextTools(
      buildReviewPrompt(
        guidelines,
        benchCase.diff,
        buildPromptOptions(config, benchCase.dir, projectContext),
      ),
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
        return [];
      }
    }

    const port = deps.modelPort ?? buildModelPort(config, deps.credentials);
    const reply = await port.complete(request);
    const guidelinesById = new Map(guidelines.map((guideline) => [guideline.id, guideline]));
    const parsed = parseReviewResponse(reply.text, {
      guidelinesById,
      generalPass: config.review.generalPass,
      observationSeverityCap: config.review.observationSeverityCap,
    });
    // same AST gate a live review applies, reading the case's files/ tree
    const structural = verifyStructural(parsed.findings, guidelinesById, (file) =>
      readSourceForStructuralCheck(filesRoot, file),
    );
    return structural.kept.map((finding) => ({
      file: finding.file,
      line: finding.line,
      ...(finding.kind === "violation" ? { guidelineId: finding.guidelineId } : {}),
    }));
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
