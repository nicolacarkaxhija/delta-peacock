import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/loader.js";
import type { Config } from "../config/schema.js";
import { buildContextProvider } from "../context/build.js";
import { capToTokenBudget } from "../context/port.js";
import type { RuntimeDeps } from "../deps.js";
import type { Finding } from "../domain/finding.js";
import { evaluateGate } from "../domain/gate.js";
import { ToolError } from "../errors.js";
import {
  acquireDiff,
  changedFilesFromDiff,
  filterDiffByPath,
  newLineTexts,
  resolveTargetRef,
  type AcquiredDiff,
} from "../git/diff.js";
import { appliesTo } from "../guidelines/languages.js";
import { resolveGuidelines } from "../guidelines/loader.js";
import { buildModelPort } from "../model/build.js";
import type { ModelUsage } from "../model/port.js";
import { anyRateConfigured, computeCost } from "../model/usage.js";
import { checkBudget, guardActive } from "../cost/guard.js";
import { defaultCounterPath, monthKey, recordSpend } from "../cost/counter.js";
import { addUsage } from "../model/usage.js";
import { buildModelPortFor } from "../model/build.js";
import { renderCodeQuality, renderSarif } from "./artifacts.js";
import { loadBaseline, splitByBaseline, writeBaseline } from "./baseline.js";
import { calibrate, type SuppressedFinding } from "./calibrate.js";
import { runEnsemble, type MemberOutcome } from "./ensemble.js";
import { buildReviewPrompt } from "./prompt.js";
import { parseReviewResponse } from "./parse.js";
import { buildScmPort } from "../scm/build.js";
import { publishReview } from "../scm/publish.js";
import { compileCustomPatterns, redactDiff } from "./redact.js";
import { renderReview } from "./render.js";
import { buildReport } from "./report.js";

export type ReviewDeps = RuntimeDeps;

export interface ReviewOptions {
  /** Accept every current finding into the baseline, then pass the gate. */
  writeBaseline?: boolean;
}

export async function runReview(
  deps: ReviewDeps,
  flags: Readonly<Record<string, string>>,
  options: ReviewOptions = {},
): Promise<number> {
  const config = loadConfig({ root: deps.cwd, env: deps.env, flags });

  const resolvedTarget = resolveTargetRef(
    deps.cwd,
    config.review.target,
    config.review.fetchTarget,
  );
  for (const notice of resolvedTarget.notices) deps.err(`${notice}\n`);

  const loaded = resolveGuidelines(
    deps.cwd,
    config.review.guidelinesRef,
    config.review.guidelinesDir,
    resolvedTarget.ref,
    config.review.packs,
  );
  for (const notice of loaded.notices) deps.err(`${notice}\n`);
  for (const problem of loaded.problems) deps.err(`guideline skipped: ${problem}\n`);
  if (loaded.guidelines.length === 0) {
    deps.out("no usable guidelines found; nothing to review against\n");
    await publishAllClear(deps, config);
    return 0;
  }

  let acquired: AcquiredDiff;
  try {
    acquired = acquireDiff(
      deps.cwd,
      {
        target: config.review.target,
        fetchTarget: config.review.fetchTarget,
        include: config.review.include,
        exclude: config.review.exclude,
        maxDiffBytes: config.review.maxDiffBytes,
        ...(config.review.lastReviewedCommit !== undefined
          ? { lastReviewedCommit: config.review.lastReviewedCommit }
          : {}),
      },
      resolvedTarget,
    );
  } catch (error) {
    acquired = await apiDiffFallback(deps, config, error);
  }
  for (const notice of acquired.notices) deps.err(`${notice}\n`);
  if (acquired.skipped === "too-large") {
    deps.out("review skipped: the diff exceeds the configured size ceiling\n");
    await publishAllClear(deps, config);
    return 0;
  }
  const diff = acquired.text;
  if (diff.trim() === "") {
    deps.out(`nothing to review: no changes against ${acquired.targetRef}\n`);
    await publishAllClear(deps, config);
    return 0;
  }

  const changedFiles = changedFilesFromDiff(diff);
  const guidelines = loaded.guidelines.filter((guideline) => appliesTo(guideline, changedFiles));
  const inapplicable = loaded.guidelines.length - guidelines.length;
  if (inapplicable > 0) {
    deps.err(`${String(inapplicable)} guideline(s) do not apply to this change\n`);
  }
  if (guidelines.length === 0) {
    deps.out("no guidelines apply to this change; nothing to review against\n");
    await publishAllClear(deps, config);
    return 0;
  }

  const redacted = redactDiff(diff, compileCustomPatterns(config.redaction.patterns));
  const redactionTotal = Object.values(redacted.counts).reduce((sum, n) => sum + n, 0);
  if (redactionTotal > 0) {
    deps.err(`${String(redactionTotal)} secret-shaped value(s) redacted before the model call\n`);
  }

  const contextProvider = buildContextProvider(config, {
    env: deps.env,
    ...(deps.embeddingPort ? { embeddingPort: deps.embeddingPort } : {}),
    ...(deps.clock ? { clock: deps.clock } : {}),
  });
  const contextInput = { cwd: deps.cwd, diff: redacted.text, changedFiles };
  const projectContext = capToTokenBudget(
    await contextProvider.systemContext(contextInput),
    config.context.maxTokens,
  );
  for (const notice of contextProvider.notices?.() ?? []) deps.err(`${notice}\n`);
  const contextTools = contextProvider.tools?.(contextInput);

  const request = {
    ...buildReviewPrompt(guidelines, redacted.text, {
      generalPass: config.review.generalPass,
      ...(projectContext !== "" ? { projectContext } : {}),
    }),
    ...(contextTools !== undefined
      ? { tools: contextTools, maxToolRounds: config.context.maxToolRounds }
      : {}),
  };
  const parseOptions = {
    guidelinesById: new Map(guidelines.map((guideline) => [guideline.id, guideline])),
    generalPass: config.review.generalPass,
    observationSeverityCap: config.review.observationSeverityCap,
  };

  const now = deps.clock?.() ?? new Date();
  if (guardActive(config)) {
    const decision = await checkBudget(config, request, now);
    for (const notice of decision.notices) deps.err(`${notice}\n`);
    if (!decision.allowed) {
      for (const reason of decision.reasons) deps.out(`budget: ${reason}\n`);
      deps.out("review blocked by the cost guard before any model call\n");
      if (config.output.report !== undefined) {
        const blockedReport = buildReport({
          findings: [],
          filtered: [],
          proposals: [],
          droppedUncited: 0,
          adjustedLines: 0,
          redactions: redacted.counts,
          gate: evaluateGate([], config.gate.failOn),
          budget: {
            blocked: true,
            estimated: decision.estimated,
            ...(decision.monthToDate !== undefined ? { monthToDate: decision.monthToDate } : {}),
            reasons: decision.reasons,
          },
        });
        writeFileSync(
          path.resolve(deps.cwd, config.output.report),
          `${JSON.stringify(blockedReport, null, 2)}\n`,
        );
      }
      // advisory posture absorbs the block; a gating posture must fail loudly
      return config.gate.failOn === "none" ? 0 : 1;
    }
  }

  let parsed;
  let usage: ModelUsage | undefined;
  let ensembleMembers: MemberOutcome[] | undefined;
  let toolCalls: number | undefined;
  if (config.ensemble.enabled) {
    const ensemble = await runEnsemble(deps, config, request, parseOptions);
    for (const notice of ensemble.notices) deps.err(`${notice}\n`);
    parsed = ensemble.parsed;
    usage = ensemble.usage;
    ensembleMembers = ensemble.members;
  } else {
    const modelPort = deps.modelPort ?? buildModelPort(config, deps.env);
    let reply;
    try {
      reply = await modelPort.complete(request);
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError(`model call failed: ${(error as Error).message}`);
    }
    parsed = parseReviewResponse(reply.text, parseOptions);
    usage = reply.usage;
    if (reply.toolCalls !== undefined && reply.toolCalls > 0) {
      deps.err(`agentic context: ${String(reply.toolCalls)} tool call(s) served\n`);
      toolCalls = reply.toolCalls;
    }
  }

  const partitioned = partitionFindings(parsed.findings, config);
  const filtered = partitioned.filtered;
  let kept = partitioned.kept;
  let suppressed: SuppressedFinding[] = [];
  if (config.calibration.enabled) {
    const ref = config.calibration.model;
    const calibrationPort = ref
      ? (deps.modelPortFor?.(ref) ?? buildModelPortFor(ref, deps.env))
      : (deps.modelPort ?? buildModelPort(config, deps.env));
    const outcome = await calibrate(calibrationPort, kept, redacted.text);
    for (const notice of outcome.notices) deps.err(`${notice}\n`);
    kept = outcome.findings;
    suppressed = outcome.suppressed;
    if (outcome.usage) usage = usage ? addUsage(usage, outcome.usage) : outcome.usage;
    if (suppressed.length > 0) {
      deps.err(`calibration suppressed ${String(suppressed.length)} finding(s)\n`);
    }
  }
  if (options.writeBaseline === true) {
    const accepted = writeBaseline(deps.cwd, config.review.baselinePath, kept);
    deps.out(
      `baseline written: ${String(accepted)} finding(s) accepted into ${config.review.baselinePath}\n`,
    );
  }
  // a broken baseline fails loudly, or it would silently un-accept everything
  const baseline = loadBaseline(deps.cwd, config.review.baselinePath);
  let baselined: Finding[] = [];
  if (baseline.size > 0) {
    const split = splitByBaseline(kept, baseline);
    kept = split.fresh;
    baselined = split.baselined;
    if (baselined.length > 0) {
      deps.err(
        `${String(baselined.length)} baselined finding(s) inform the report but never gate\n`,
      );
    }
  }
  const { violations, observations, proposals } = lanesOf(kept, config);
  // the gate judges what calibration let through, never what it removed
  const gate = evaluateGate(kept, config.gate.failOn);

  deps.out(
    renderReview({
      violations,
      observations,
      proposals,
      droppedUncited: parsed.droppedUncited,
      adjustedLines: parsed.adjustedLines,
      filtered: filtered.length,
      gate,
    }),
  );

  const wantsArtifacts =
    config.output.report !== undefined ||
    config.output.sarifPath !== undefined ||
    config.output.codeQualityPath !== undefined;
  if (wantsArtifacts) {
    const anchorTexts = newLineTexts(redacted.text);
    const report = buildReport({
      lineTextOf: (finding) => anchorTexts.get(finding.file)?.get(finding.line),
      findings: kept,
      baselined,
      filtered,
      proposals,
      droppedUncited: parsed.droppedUncited,
      adjustedLines: parsed.adjustedLines,
      redactions: redacted.counts,
      gate,
      ...(usage ? { usage } : {}),
      ...(usage && anyRateConfigured(config.cost) ? { cost: computeCost(usage, config.cost) } : {}),
      ...(ensembleMembers !== undefined
        ? { ensemble: { mode: config.ensemble.mode, members: ensembleMembers } }
        : {}),
      ...(toolCalls !== undefined ? { toolCalls } : {}),
      ...(config.calibration.enabled ? { calibration: { suppressed } } : {}),
    });
    if (config.output.report !== undefined) {
      writeFileSync(
        path.resolve(deps.cwd, config.output.report),
        `${JSON.stringify(report, null, 2)}\n`,
      );
    }
    if (config.output.sarifPath !== undefined) {
      writeFileSync(path.resolve(deps.cwd, config.output.sarifPath), renderSarif(report.findings));
    }
    if (config.output.codeQualityPath !== undefined) {
      writeFileSync(
        path.resolve(deps.cwd, config.output.codeQualityPath),
        renderCodeQuality(report.findings),
      );
    }
  }

  await publishIfConfigured(deps, config, {
    findings: kept,
    proposals,
    droppedUncited: parsed.droppedUncited,
    filtered: filtered.length,
    gate,
    commitStatus: config.scm.commitStatus,
    comments: config.scm.comments,
    codeInsights: config.scm.codeInsights,
  });

  if (usage && anyRateConfigured(config.cost)) {
    const spent = computeCost(usage, config.cost).total;
    recordSpend(config.cost.counterPath ?? defaultCounterPath(), monthKey(now), spent);
  }

  return gate.failed ? 2 : 0;
}

function partitionFindings(findings: readonly Finding[], config: Config) {
  const floor = config.review.confidenceFloor;
  return {
    kept: findings.filter((finding) => (finding.confidence ?? 1) >= floor),
    filtered: findings.filter((finding) => (finding.confidence ?? 1) < floor),
  };
}

/** Lanes are computed after calibration, so demotions land in the right one. */
function lanesOf(kept: readonly Finding[], config: Config) {
  const observations = kept.filter((finding) => finding.kind === "observation");
  return {
    violations: kept.filter((finding) => finding.kind === "violation"),
    observations,
    proposals: observations
      .flatMap((observation) =>
        observation.proposedGuideline ? [observation.proposedGuideline] : [],
      )
      .slice(0, config.review.maxProposedGuidelines),
  };
}

/**
 * When local git cannot produce the diff (shallow or absent clone), the SCM
 * host's own PR diff serves as the fallback, with degraded capabilities.
 */
async function apiDiffFallback(
  deps: ReviewDeps,
  config: Config,
  cause: unknown,
): Promise<AcquiredDiff> {
  if (config.scm.provider === "local") throw cause;
  const scm = deps.scmPort ?? buildScmPort(config, deps.env);
  if (scm.fetchPullRequestDiff === undefined) throw cause;
  const causeMessage = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
  const raw = await scm.fetchPullRequestDiff();
  const text = filterDiffByPath(raw, config.review.include, config.review.exclude);
  const notices = [
    `local git diff unavailable (${String(causeMessage)}); using the SCM API diff instead`,
    "incremental review and target fetching degrade in API-diff mode",
  ];
  if (Buffer.byteLength(text, "utf8") > config.review.maxDiffBytes) {
    notices.push("diff exceeds the configured size ceiling");
    return { text: "", mode: "full", targetRef: "scm api", notices, skipped: "too-large" };
  }
  return { text, mode: "full", targetRef: "scm api", notices };
}

/**
 * A run with nothing to review still reconciles: stale comments from earlier
 * runs resolve, the summary refreshes, and the status turns green.
 */
async function publishAllClear(deps: ReviewDeps, config: Config): Promise<void> {
  await publishIfConfigured(deps, config, {
    findings: [],
    proposals: [],
    droppedUncited: 0,
    filtered: 0,
    gate: evaluateGate([], config.gate.failOn),
    commitStatus: config.scm.commitStatus,
  });
}

async function publishIfConfigured(
  deps: ReviewDeps,
  config: Config,
  input: Parameters<typeof publishReview>[1],
): Promise<void> {
  if (config.scm.provider === "local") return;
  if (config.scm.dryRun) {
    // the hard guarantee: in a dry run, no request of any kind goes out
    deps.err("dry run: no comments, summary or status will be posted\n");
    return;
  }
  const scm = deps.scmPort ?? buildScmPort(config, deps.env);
  const outcome = await publishReview(scm, input);
  for (const notice of outcome.notices) deps.err(`${notice}\n`);
  deps.err(
    `published: ${String(outcome.created)} created, ${String(outcome.updated)} updated, ${String(outcome.deleted)} resolved, ${String(outcome.unchanged)} unchanged\n`,
  );
}
