import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadCases, runBench, type BenchCase, type ReviewFn } from "../bench/harness.js";
import { formatTable } from "../bench/harness.js";
import { overlapMatrix, type ProducedFinding } from "../bench/scoring.js";
import { loadCredentials } from "../config/credentials.js";
import { loadConfig } from "../config/loader.js";
import { buildContextProvider } from "../context/build.js";
import { capToTokenBudget } from "../context/port.js";
import type { RuntimeDeps } from "../deps.js";
import { changedFilesFromDiff } from "../git/diff.js";
import { loadGuidelinesFromFiles, readWorkingTreeGuidelines } from "../guidelines/loader.js";
import { buildModelPort } from "../model/build.js";
import { parseReviewResponse } from "../review/parse.js";
import { buildPromptOptions, buildReviewPrompt } from "../review/prompt.js";

/**
 * Each case is self-contained: its own guidelines, its own optional files/
 * tree for context strategies, no git required. The same pipeline pieces
 * that review PRs judge the cases, so bench results transfer.
 */
function reviewFnFrom(deps: RuntimeDeps, flags: Readonly<Record<string, string>>): ReviewFn {
  return async (benchCase: BenchCase): Promise<ProducedFinding[]> => {
    const config = loadConfig({ root: deps.cwd, env: deps.env, flags });
    const guidelines = loadGuidelinesFromFiles(
      readWorkingTreeGuidelines(path.join(benchCase.dir, "guidelines")),
      config.review.frontmatterContract,
    ).guidelines;

    const filesRoot = path.join(benchCase.dir, "files");
    const changedFiles = changedFilesFromDiff(benchCase.diff);
    let projectContext = "";
    if (existsSync(filesRoot)) {
      const provider = buildContextProvider(config, {
        credentials: loadCredentials(deps.env),
        ...(deps.embeddingPort ? { embeddingPort: deps.embeddingPort } : {}),
      });
      projectContext = capToTokenBudget(
        await provider.systemContext({ cwd: filesRoot, diff: benchCase.diff, changedFiles }),
        config.context.maxTokens,
      );
    }

    const request = buildReviewPrompt(
      guidelines,
      benchCase.diff,
      buildPromptOptions(config, benchCase.dir, projectContext),
    );
    const port = deps.modelPort ?? buildModelPort(config, loadCredentials(deps.env));
    const reply = await port.complete(request);
    const parsed = parseReviewResponse(reply.text, {
      guidelinesById: new Map(guidelines.map((guideline) => [guideline.id, guideline])),
      generalPass: config.review.generalPass,
      observationSeverityCap: config.review.observationSeverityCap,
    });
    return parsed.findings.map((finding) => ({
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
