import { writeFileSync } from "node:fs";
import path from "node:path";
import type { ToolSet } from "ai";
import type { Config } from "../config/schema.js";
import { buildContextProvider } from "../context/build.js";
import { capToTokenBudget } from "../context/port.js";
import type { RuntimeDeps } from "../deps.js";
import type { Finding } from "../domain/finding.js";
import type { Guideline } from "../domain/guideline.js";
import { evaluateGate } from "../domain/gate.js";
import { ToolError } from "../errors.js";
import {
  acquireDiff,
  addedLineCount,
  changedFilesFromDiff,
  commitAuthor,
  filterDiffByPath,
  LocalDiffUnavailableError,
  newLineTexts,
  resolveTargetRef,
  stagedDiff,
  type AcquiredDiff,
} from "../git/diff.js";
import { appliesTo } from "../guidelines/languages.js";
import { resolveGuidelines } from "../guidelines/loader.js";
import { buildModelPort } from "../model/build.js";
import type { ModelRequest, ModelUsage } from "../model/port.js";
import { anyRateConfigured, computeCost } from "../model/usage.js";
import { checkCostGuard, guardActive } from "../cost/guard.js";
import { defaultCounterPath, monthKey, recordSpend } from "../cost/counter.js";
import { addUsage } from "../model/usage.js";
import { buildModelPortFor } from "../model/build.js";
import { withResponseCache } from "../model/cache.js";
import { renderCodeQuality, renderSarif } from "./artifacts.js";
import { planBudget, splitDiffByFile, type BudgetPlan } from "./budget.js";
import { detectLinters, linterInstruction } from "./linters.js";
import { loadBaseline, splitByBaseline, writeBaseline } from "./baseline.js";
import { calibrate } from "./calibrate.js";
import { dedupeFindings, runEnsemble, type MemberOutcome } from "./ensemble.js";
import { buildReviewPrompt } from "./prompt.js";
import {
  parseReviewResponse,
  relocateFindings,
  type ParsedReview,
  type ParseOptions,
  type RejectedCandidate,
} from "./parse.js";
import { buildScmPort } from "../scm/build.js";
import { isDryRun, publishReview } from "../scm/publish.js";
import { compileCustomPatterns, redactDiff, type RedactedDiff } from "./redact.js";
import { renderReview } from "./render.js";
import { harvestUncited } from "./harvest.js";
import { findWaiver, parseWaivers, type Waiver } from "./waiver.js";
import { buildReport, type WaivedFinding } from "./report.js";
import { writeDrafts } from "../guidelines/draft.js";
import { appendRecord, guidelineCounts, severityCounts } from "../stats/record.js";

export type ReviewDeps = RuntimeDeps;

export interface ReviewOptions {
  /** Accept every current finding into the baseline, then pass the gate. */
  writeBaseline?: boolean;
  /** Review the index against HEAD, for pre-commit hooks. */
  staged?: boolean;
  /**
   * Observations-only run for an empty corpus: never gates, never posts, and
   * accumulates proposed guidelines as drafts a human promotes.
   */
  bootstrap?: boolean;
  /** Where bootstrap drafts land; defaults to guidelines-drafts. */
  draftsDir?: string;
  /** Log the raw payload of every rejected candidate to stderr. */
  explainDrops?: boolean;
}

export async function runReview(
  deps: ReviewDeps,
  flags: Readonly<Record<string, string>>,
  options: ReviewOptions = {},
): Promise<number> {
  const config = deps.loadConfig(flags);

  if (options.staged === true) {
    // at commit time there is no target ref and no pull request to speak of
    if (config.review.lastReviewedCommit !== undefined) {
      throw new ToolError("--staged reviews the index; it cannot combine with lastReviewedCommit");
    }
    if (config.scm.provider !== "local") {
      throw new ToolError("--staged is a pre-commit review; it needs no SCM configured");
    }
  }
  const resolvedTarget =
    options.staged === true
      ? { ref: "HEAD", notices: [] }
      : resolveTargetRef(deps.cwd, config.review.target, config.review.fetchTarget);
  for (const notice of resolvedTarget.notices) deps.err(`${notice}\n`);

  let loaded;
  try {
    loaded = resolveGuidelines(
      deps.cwd,
      options.staged === true ? "source" : config.review.guidelinesRef,
      config.review.guidelinesDir,
      resolvedTarget.ref,
      config.review.packs,
      config.review.frontmatterContract,
    );
  } catch (error) {
    // bootstrapping a repo that has no guidelines directory yet is fine
    if (options.bootstrap !== true || !(error instanceof ToolError)) throw error;
    loaded = { guidelines: [], problems: [], notices: [], disabled: 0, origin: "none" };
  }
  for (const notice of loaded.notices) deps.err(`${notice}\n`);
  for (const problem of loaded.problems) deps.err(`guideline skipped: ${problem}\n`);
  if (loaded.guidelines.length === 0 && options.bootstrap !== true) {
    deps.out("no usable guidelines found; nothing to review against\n");
    await publishAllClear(deps, config);
    return 0;
  }

  let acquired: AcquiredDiff;
  if (options.staged === true) {
    acquired = stagedDiff(deps.cwd, {
      include: config.review.include,
      exclude: config.review.exclude,
      maxDiffBytes: config.review.maxDiffBytes,
    });
  } else {
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
      // ADR 0004 scopes the fallback to a shallow or absent local clone; any
      // other failure (a malformed ref, say) is a real problem to surface
      if (!(error instanceof LocalDiffUnavailableError)) throw error;
      acquired = await apiDiffFallback(deps, config, error);
    }
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
  if (guidelines.length === 0 && options.bootstrap !== true) {
    deps.out("no guidelines apply to this change; nothing to review against\n");
    await publishAllClear(deps, config);
    return 0;
  }

  const {
    redacted,
    request,
    diffBatches,
    batchContexts,
    contextTools,
    parseOptions,
    promptOf,
    budgetDegraded,
    linters,
  } = await assembleReview(deps, config, diff, guidelines, changedFiles);

  const now = deps.clock?.() ?? new Date();
  if (guardActive(config)) {
    const decision = await checkCostGuard(config, request, now, { batches: diffBatches.length });
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

  const executed = await executeReview(
    deps,
    config,
    request,
    diffBatches,
    batchContexts,
    contextTools,
    parseOptions,
    promptOf,
  );
  // the model's own line count drifts on multi-hunk files even when its
  // cited snippet is right; re-anchor each finding to where that snippet
  // actually sits before anything downstream keys, waives, or posts on line
  const parsed: ParsedReview = {
    ...executed.parsed,
    findings: relocateFindings(executed.parsed.findings, newLineTexts(redacted.text)),
  };
  if (options.explainDrops === true) {
    for (const entry of parsed.rejected) {
      deps.err(`rejected (${entry.reason}): ${entry.raw}\n`);
    }
  }
  if (config.review.harvestUncited) {
    const written = writeDrafts(
      deps.cwd,
      options.draftsDir ?? "guidelines-drafts",
      harvestUncited(parsed.rejected),
    );
    if (written.length > 0) {
      deps.out(
        `harvested ${String(written.length)} guideline draft(s) from recurring uncited findings; a human promotes a draft by moving it into the guidelines directory\n`,
      );
    }
  }
  let usage = executed.usage;
  const ensembleMembers = executed.ensembleMembers;
  const toolCalls = executed.toolCalls;
  const cachedResponse = executed.cachedResponse;

  const finalized = await finalizeFindings(
    deps,
    config,
    options,
    parsed.findings,
    redacted.text,
    usage,
  );
  const filtered = finalized.filtered;
  const baselined = finalized.baselined;
  usage = finalized.usage;
  // an in-code waiver moves a violation out of the gate but not out of the report
  const waivers = parseWaivers(newLineTexts(redacted.text)).waivers;
  const waived: { finding: Finding; waiver: Waiver }[] = [];
  const kept: Finding[] = [];
  for (const finding of finalized.kept) {
    const waiver = findWaiver(finding, waivers);
    if (waiver === undefined) kept.push(finding);
    else waived.push({ finding, waiver });
  }
  const today = now.toISOString().slice(0, 10);
  const waivedEntries: WaivedFinding[] = waived.map(({ finding, waiver }) => ({
    guidelineId: finding.kind === "violation" ? finding.guidelineId : "",
    file: finding.file,
    line: finding.line,
    reason: waiver.reason,
    // until never moves the gate (ADR 0008); an expired one only reads as stale
    ...(waiver.until !== undefined ? { until: waiver.until, expired: waiver.until < today } : {}),
  }));
  const { violations, observations, proposals } = lanesOf(kept, config);
  // the gate judges what calibration let through and no waiver excused
  const gate = evaluateGate(kept, config.gate.failOn);

  deps.out(
    renderReview({
      violations,
      observations,
      proposals,
      droppedUncited: parsed.droppedUncited,
      droppedOutOfScope: parsed.droppedOutOfScope,
      adjustedLines: parsed.adjustedLines,
      droppedMalformed: parsed.droppedMalformed,
      filtered: filtered.length,
      waived: waivedEntries,
      gate,
    }),
  );

  if (options.bootstrap === true) {
    const drafts = observations
      .flatMap((observation) =>
        observation.proposedGuideline !== undefined
          ? [{ observation, proposal: observation.proposedGuideline }]
          : [],
      )
      .map(({ observation, proposal }) => {
        return {
          id: proposal.id,
          severity: proposal.severity,
          title: observation.title,
          body: observation.body,
          rationale: proposal.rationale,
        };
      });
    const written = writeDrafts(deps.cwd, options.draftsDir ?? "guidelines-drafts", drafts);
    for (const file of written) deps.out(`draft written: ${file}\n`);
    deps.out(
      `bootstrap: ${String(observations.length)} observation(s), ${String(written.length)} guideline draft(s); a human promotes a draft by moving it into the guidelines directory\n`,
    );
    // bootstrap never posts and never gates; it only proposes
    return 0;
  }

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
      ...(waivedEntries.length > 0 ? { waived: waivedEntries } : {}),
      ...(parsed.rejected.length > 0 ? { rejected: parsed.rejected } : {}),
      filtered,
      proposals,
      droppedUncited: parsed.droppedUncited,
      droppedOutOfScope: parsed.droppedOutOfScope,
      adjustedLines: parsed.adjustedLines,
      droppedMalformed: parsed.droppedMalformed,
      redactions: redacted.counts,
      gate,
      ...(usage ? { usage } : {}),
      ...(usage && anyRateConfigured(config.cost) ? { cost: computeCost(usage, config.cost) } : {}),
      ...(ensembleMembers !== undefined
        ? { ensemble: { mode: config.ensemble.mode, members: ensembleMembers } }
        : {}),
      ...(toolCalls !== undefined ? { toolCalls } : {}),
      ...(cachedResponse ? { cachedResponse: true as const } : {}),
      ...(budgetDegraded ? { budgetDegraded: true as const } : {}),
      ...(linters.length > 0 ? { lintersDetected: linters } : {}),
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
    dryRun: isDryRun(config),
  });

  if (usage && anyRateConfigured(config.cost)) {
    const spent = computeCost(usage, config.cost).total;
    await recordSpend(config.cost.counterPath ?? defaultCounterPath(), monthKey(now), spent);
  }

  if (config.stats.enabled) {
    // the recorded findings are what survived to the gate, not what was baselined
    await appendRecord(deps.cwd, config.stats.path, {
      at: now.toISOString(),
      author: commitAuthor(deps.cwd, "HEAD"),
      addedLines: addedLineCount(diff),
      bySeverity: severityCounts(kept),
      byGuideline: guidelineCounts(kept),
    });
  }

  return gate.failed ? 2 : 0;
}

interface AssembledReview {
  redacted: RedactedDiff;
  request: ModelRequest;
  diffBatches: string[];
  /** The context text resolved for each entry of diffBatches, "" where dropped. */
  batchContexts: string[];
  /** On-demand tools every batch should carry; undefined means the strategy offers none. */
  contextTools: ToolSet | undefined;
  parseOptions: ParseOptions;
  promptOf: (diffText: string, context: string) => ModelRequest;
  budgetDegraded: boolean;
  linters: string[];
}

/**
 * Once the whole diff cannot fit even without context, splits it into
 * file-boundary batches and re-weighs context against each one alone: a
 * batch this small can often afford what the whole diff could not, so
 * agentic/repo_map/rag are not abandoned just because *something* had to be
 * batched. A batch that still cannot afford context, even alone, is named in
 * a notice rather than silently dropped.
 */
function planBatches(
  deps: ReviewDeps,
  whole: BudgetPlan,
  diff: string,
  projectContext: string,
  prefix: string,
  windowTokens: number,
): { diffBatches: string[]; batchContexts: string[] } {
  if (!whole.batchDiff) {
    return { diffBatches: [diff], batchContexts: [whole.dropContext ? "" : projectContext] };
  }
  const diffBatches = splitDiffByFile(diff, windowTokens);
  const batchContexts = diffBatches.map((batchDiff, index) => {
    const batchPlan = planBudget({
      prefix,
      context: projectContext,
      diff: batchDiff,
      windowTokens,
    });
    if (!batchPlan.batchDiff) return batchPlan.dropContext ? "" : projectContext;
    // this one batch, alone, still exceeds the window even without context:
    // named so a human can see which files paid the cost, instead of a
    // blanket drop that reads the same whether one batch or all of them did
    const files = changedFilesFromDiff(batchDiff).join(", ") || "unnamed files";
    deps.err(
      `budget: batch ${String(index + 1)}/${String(diffBatches.length)} (${files}) exceeds the window even without cross-file context; reviewing it without context\n`,
    );
    return "";
  });
  return { diffBatches, batchContexts };
}

/**
 * The assemble stage: redact the diff, gather cross-file context, detect
 * linters, and weigh the prompt against the window, degrading (drop context,
 * then batch the diff) so what leaves here already fits. Everything the rest of
 * the pipeline needs to call the model and build the report comes back in one
 * struct; the notices are emitted as they happen.
 */
async function assembleReview(
  deps: ReviewDeps,
  config: Config,
  diff: string,
  guidelines: readonly Guideline[],
  changedFiles: readonly string[],
): Promise<AssembledReview> {
  const redacted = redactDiff(diff, compileCustomPatterns(config.redaction.patterns), {
    strict: config.redaction.strict,
  });
  const redactionTotal = Object.values(redacted.counts).reduce((sum, n) => sum + n, 0);
  if (redactionTotal > 0) {
    deps.err(`${String(redactionTotal)} secret-shaped value(s) redacted before the model call\n`);
  }

  const contextProvider = buildContextProvider(config, {
    credentials: deps.credentials,
    ...(deps.embeddingPort ? { embeddingPort: deps.embeddingPort } : {}),
    ...(deps.clock ? { clock: deps.clock } : {}),
  });
  const contextInput = { cwd: deps.cwd, diff: redacted.text, changedFiles: [...changedFiles] };
  const projectContext = capToTokenBudget(
    await contextProvider.systemContext(contextInput),
    config.context.maxTokens,
  );
  for (const notice of contextProvider.notices?.() ?? []) deps.err(`${notice}\n`);
  const contextTools = contextProvider.tools?.(contextInput);

  const linters = detectLinters(deps.cwd);
  if (linters.length > 0) deps.err(`linters detected (not duplicated): ${linters.join(", ")}\n`);
  const promptOf = (diffText: string, context: string): ModelRequest =>
    buildReviewPrompt(guidelines, diffText, {
      generalPass: config.review.generalPass,
      language: config.review.language,
      linterInstruction: linterInstruction(linters),
      ...(context !== "" ? { projectContext: context } : {}),
    });
  // one place weighs prefix + context + diff against the window and degrades
  const prefix = promptOf("", "").system;
  const plan = planBudget({
    prefix,
    context: projectContext,
    diff: redacted.text,
    windowTokens: config.review.windowTokens,
  });
  for (const notice of plan.notices) deps.err(`${notice}\n`);
  // splitting (when needed) happens regardless of contextTools: agentic tools
  // do not shrink the diff itself, so a batch too big to afford context whole
  // is still too big to afford context with tools bolted on. Each batch then
  // gets its own context decision instead of one drop-for-everyone verdict.
  const { diffBatches, batchContexts } = planBatches(
    deps,
    plan,
    redacted.text,
    projectContext,
    prefix,
    config.review.windowTokens,
  );
  const budgetDegraded = plan.dropContext || plan.batchDiff;

  const request = {
    ...promptOf(diffBatches[0] ?? redacted.text, batchContexts[0] ?? ""),
    ...(contextTools !== undefined
      ? { tools: contextTools, maxToolRounds: config.context.maxToolRounds }
      : {}),
  };
  const parseOptions = {
    guidelinesById: new Map(guidelines.map((guideline) => [guideline.id, guideline])),
    generalPass: config.review.generalPass,
    observationSeverityCap: config.review.observationSeverityCap,
  };
  return {
    redacted,
    request,
    diffBatches,
    batchContexts,
    contextTools,
    parseOptions,
    promptOf,
    budgetDegraded,
    linters,
  };
}

interface ExecuteResult {
  parsed: ParsedReview;
  usage: ModelUsage | undefined;
  ensembleMembers: MemberOutcome[] | undefined;
  toolCalls: number | undefined;
  cachedResponse: boolean;
}

/**
 * The complete-and-parse stage: run the model (ensemble members, or a single
 * pass over one or more diff batches) and fold every reply into one parsed
 * result plus its usage, tool-call and cache metadata. Isolated so the batch
 * fan-out lives in one named place rather than buried in the pipeline, which is
 * where its cost-estimate mismatch once hid.
 */
async function executeReview(
  deps: ReviewDeps,
  config: Config,
  request: ModelRequest,
  diffBatches: readonly string[],
  batchContexts: readonly string[],
  contextTools: ToolSet | undefined,
  parseOptions: ParseOptions,
  promptOf: (diffText: string, context: string) => ModelRequest,
): Promise<ExecuteResult> {
  if (config.ensemble.enabled) {
    const ensemble = await runEnsemble(deps, config, request, parseOptions);
    for (const notice of ensemble.notices) deps.err(`${notice}\n`);
    return {
      parsed: ensemble.parsed,
      usage: ensemble.usage,
      ensembleMembers: ensemble.members,
      toolCalls: undefined,
      cachedResponse: false,
    };
  }

  const modelPort = withResponseCache(
    deps.modelPort ?? buildModelPort(config, deps.credentials),
    config,
    deps.cwd,
    () => deps.clock?.() ?? new Date(),
    (notice) => {
      deps.err(`${notice}\n`);
    },
  );
  if (diffBatches.length > 1) {
    deps.err(`budget: reviewing the diff in ${String(diffBatches.length)} batch(es)\n`);
  }
  const merged: Finding[] = [];
  let usage: ModelUsage | undefined;
  let toolCalls: number | undefined;
  let cachedResponse = false;
  let batchDropped = 0;
  let batchOutOfScope = 0;
  let batchAdjusted = 0;
  let batchMalformed = 0;
  const batchRejected: RejectedCandidate[] = [];
  for (const [index, batchDiff] of diffBatches.entries()) {
    // every batch carries its own (already-budgeted) context and the same
    // tools: agentic/repo_map/rag are not a whole-diff privilege, so a batch
    // is never the one place they silently stop running
    const batchRequest = {
      ...promptOf(batchDiff, batchContexts[index] ?? ""),
      ...(contextTools !== undefined
        ? { tools: contextTools, maxToolRounds: config.context.maxToolRounds }
        : {}),
    };
    let reply;
    try {
      reply = await modelPort.complete(batchRequest);
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError(`model call failed: ${(error as Error).message}`);
    }
    const batchParsed = parseReviewResponse(reply.text, parseOptions);
    merged.push(...batchParsed.findings);
    batchDropped += batchParsed.droppedUncited;
    batchOutOfScope += batchParsed.droppedOutOfScope;
    batchAdjusted += batchParsed.adjustedLines;
    batchMalformed += batchParsed.droppedMalformed;
    batchRejected.push(...batchParsed.rejected);
    usage = usage ? (reply.usage ? addUsage(usage, reply.usage) : usage) : reply.usage;
    if (reply.toolCalls !== undefined && reply.toolCalls > 0) {
      deps.err(`agentic context: ${String(reply.toolCalls)} tool call(s) served\n`);
      toolCalls = (toolCalls ?? 0) + reply.toolCalls;
    }
    if (reply.cached === true) cachedResponse = true;
  }
  return {
    parsed: {
      // dedup only bridges batches; a single batch keeps same-base collisions
      // for the publisher to suffix, exactly as before
      findings: diffBatches.length > 1 ? dedupeFindings(merged) : merged,
      droppedUncited: batchDropped,
      droppedOutOfScope: batchOutOfScope,
      adjustedLines: batchAdjusted,
      droppedMalformed: batchMalformed,
      rejected: batchRejected,
    },
    usage,
    ensembleMembers: undefined,
    toolCalls,
    cachedResponse,
  };
}

interface FinalizedFindings {
  kept: Finding[];
  filtered: Finding[];
  baselined: Finding[];
  usage: ModelUsage | undefined;
}

/**
 * The finalize stage: drop findings under the confidence floor, run the
 * optional calibration pass (advisory only — it may attach a `calibration`
 * note to a finding but never changes kind, severity, or gate membership,
 * ADR 0008), and split off baselined findings that inform the report but
 * never gate. Returns the lanes the gate and report read, plus usage grown
 * by any calibration call.
 */
async function finalizeFindings(
  deps: ReviewDeps,
  config: Config,
  options: ReviewOptions,
  findings: readonly Finding[],
  diffText: string,
  usageIn: ModelUsage | undefined,
): Promise<FinalizedFindings> {
  const partitioned = partitionFindings(findings, config);
  const filtered = partitioned.filtered;
  let kept = partitioned.kept;
  let usage = usageIn;
  if (config.calibration.enabled) {
    const ref = config.calibration.model;
    const calibrationPort = ref
      ? (deps.modelPortFor?.(ref) ?? buildModelPortFor(ref, deps.credentials))
      : (deps.modelPort ?? buildModelPort(config, deps.credentials));
    const outcome = await calibrate(calibrationPort, kept, diffText);
    for (const notice of outcome.notices) deps.err(`${notice}\n`);
    // the gate reads exactly these findings next; calibration only annotated them
    kept = outcome.findings;
    if (outcome.usage) usage = usage ? addUsage(usage, outcome.usage) : outcome.usage;
    const flagged = kept.filter((finding) => finding.calibration !== undefined).length;
    if (flagged > 0) {
      deps.err(`calibration flagged ${String(flagged)} finding(s) for human triage\n`);
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
  return { kept, filtered, baselined, usage };
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
  const scm = deps.scmPort ?? buildScmPort(config, deps.credentials);
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
    dryRun: isDryRun(config),
  });
}

async function publishIfConfigured(
  deps: ReviewDeps,
  config: Config,
  input: Parameters<typeof publishReview>[1],
): Promise<void> {
  if (config.scm.provider === "local") return;
  // publishReview itself holds the hard guarantee now: a dry run trips zero
  // adapter writes even if this caller got the plumbing wrong.
  const scm = deps.scmPort ?? buildScmPort(config, deps.credentials);
  const outcome = await publishReview(scm, input);
  for (const notice of outcome.notices) deps.err(`${notice}\n`);
  if (!input.dryRun) {
    deps.err(
      `published: ${String(outcome.created)} created, ${String(outcome.updated)} updated, ${String(outcome.deleted)} resolved, ${String(outcome.unchanged)} unchanged\n`,
    );
  }
}
