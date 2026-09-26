import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ToolSet } from "ai";
import type { Config } from "../config/schema.js";
import { attachContextTools, resolveContext } from "../context/build.js";
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
import type { ModelPort, ModelReply, ModelRequest, ModelUsage } from "../model/port.js";
import { withFetched } from "../model/generate.js";
import { anyRateConfigured, computeCost, modelRates } from "../model/usage.js";
import { checkCostGuard, guardActive } from "../cost/guard.js";
import { defaultCounterPath, monthKey, readMonthSpend, recordSpend } from "../cost/counter.js";
import { addUsage } from "../model/usage.js";
import { buildModelPortFor } from "../model/build.js";
import { withResponseCache } from "../model/cache.js";
import { renderCodeQuality, renderSarif } from "./artifacts.js";
import { planBatches, planBudget } from "./budget.js";
import { detectLinters, linterInstruction } from "./linters.js";
import { loadBaseline, splitByBaseline, writeBaseline } from "./baseline.js";
import { calibrate } from "./calibrate.js";
import { dedupeFindings, runEnsemble, type MemberOutcome } from "./ensemble.js";
import { inPool } from "../util/pool.js";
import { buildReviewPrompt } from "./prompt.js";
import {
  parseReviewResponse,
  type ParsedReview,
  type ParseOptions,
  type RejectedCandidate,
} from "./parse.js";
import { declaredTagsBlock, readDeclaredTags, type DeclaredTags } from "./declared.js";
import {
  dropCommentMoves,
  dropGoodExamples,
  dropUnfitTags,
  linesFromDiff,
  placeFindings,
  vetSuggestions,
} from "./placement.js";
import { runGit } from "../git/git.js";
import { NOT_REVIEWED } from "../scm/comment-format.js";
import { buildScmPort } from "../scm/build.js";
import { codeInsightsEnabled, isDryRun, publishReview } from "../scm/publish.js";
import { compileCustomPatterns, redactDiff, type RedactedDiff } from "./redact.js";
import { renderReview } from "./render.js";
import { harvestUncited } from "./harvest.js";
import { findWaiver, parseWaivers, type Waiver } from "./waiver.js";
import { buildReport, type UnparsedBatch, type WaivedFinding } from "./report.js";
import { verifyStructural } from "./structural.js";
import { writeDrafts } from "../guidelines/draft.js";
import type { PullRequestText } from "../scm/port.js";
import { appendRecord, attributionOf, ledgerRecords, type Attribution } from "../stats/record.js";
import { dropChecked, runChecks, splitChecked } from "./checks/index.js";

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
  const startedAt = performance.now();
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
    await publishAllClear(deps, config, NOT_REVIEWED.noGuidelines);
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
    await publishAllClear(deps, config, NOT_REVIEWED.tooLarge);
    return 0;
  }
  const diff = acquired.text;
  if (diff.trim() === "") {
    deps.out(`nothing to review: no changes against ${acquired.targetRef}\n`);
    await publishAllClear(deps, config, NOT_REVIEWED.nothingInScope);
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
    await publishAllClear(deps, config, NOT_REVIEWED.noneApply);
    return 0;
  }

  const declared = readDeclaredTags(deps.cwd, config.review.repoConfigPath);
  // a checked guideline yields findings only on the lines its static check flags;
  // the open prompt still shows it, so the open review reads the same corpus
  const { bound, free } = splitChecked(guidelines, config.review.checks);
  const { redacted, request, passes, batchCount, parseOptions, budgetDegraded, linters } =
    await assembleReview(deps, config, diff, guidelines, changedFiles, declared);

  const now = deps.clock?.() ?? new Date();
  if (guardActive(config)) {
    const decision = await checkCostGuard(config, request, now, { batches: batchCount });
    for (const notice of decision.notices) deps.err(`${notice}\n`);
    if (!decision.allowed) {
      for (const reason of decision.reasons) deps.out(`budget: ${reason}\n`);
      deps.out("review blocked by the cost guard before any model call\n");
      await publishSkipped(deps, config, capReason(decision.reasons));
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

  let executed: ExecuteResult;
  // with every applicable guideline checked, an open call could only produce what is dropped
  const allChecked = free.length === 0 && bound.length > 0 && !config.review.generalPass;
  try {
    if (allChecked) deps.err("every applicable guideline is checked; no open review call\n");
    executed = allChecked
      ? idleExecution()
      : await executeReview(deps, config, request, passes, batchCount, parseOptions);
  } catch (error) {
    if (error instanceof ToolError) await publishFailure(deps, config, failureReason(error));
    throw error;
  }
  // the model counts line numbers by hand and drifts; each finding moves to
  // the line it quotes, or to no line at all, before anything keys on line
  const diffLines = newLineTexts(redacted.text);
  // an API diff means the checkout is not the pull request; only the diff knows its lines
  const fromApi = acquired.targetRef === "scm api";
  const linesOfFile = (file: string): readonly string[] | undefined => {
    const known = diffLines.get(file);
    if (fromApi) return known === undefined ? undefined : linesFromDiff(known);
    return linesAtHead(deps.cwd, file, known, options.staged === true);
  };
  const open = dropChecked(executed.parsed.findings, bound);
  if (open.dropped.length > 0) {
    deps.err(
      `${String(open.dropped.length)} finding(s) dropped: their guideline is checked, and only its check's lines count\n`,
    );
  }
  // two findings that quote one line under one guideline are one finding
  const placed = dedupeFindings(placeFindings(open.kept, linesOfFile));
  const checks =
    bound.length > 0
      ? await runChecks({
          bound,
          diff: redacted.text,
          read: (file) => linesOfFile(file)?.join("\n"),
          // an API diff has no checkout to follow a method into
          files: fromApi ? () => [] : () => trackedFiles(deps.cwd),
          ...(declared !== undefined ? { declared } : {}),
          configFiles: [config.review.repoConfigPath, "playwright.config.ts"],
          port: () => reviewPort(deps, config),
          redact: (text) =>
            redactDiff(text, compileCustomPatterns(config.redaction.patterns), {
              strict: config.redaction.strict,
            }).text,
        })
      : undefined;
  for (const notice of checks?.notices ?? []) deps.err(`${notice}\n`);
  // a fix that only repeats a reason already written just above is no fix
  const reviewedLines = (file: string): readonly string[] | undefined =>
    fromApi
      ? linesFromDiff(diffLines.get(file) ?? new Map<number, string>())
      : linesAtHead(deps.cwd, file, diffLines.get(file), options.staged === true);
  const moved = dropCommentMoves(placed, reviewedLines);
  if (moved.dropped.length > 0) {
    deps.err(
      `${String(moved.dropped.length)} finding(s) dropped: the reason they ask for already sits above the line or on the declaration\n`,
    );
  }
  const fitted = dropUnfitTags(moved.kept, reviewedLines, declared);
  if (fitted.dropped.length > 0) {
    deps.err(
      `${String(fitted.dropped.length)} finding(s) dropped: the feature tag they add fits no word of the test\n`,
    );
  }
  const vetted = vetSuggestions(fitted.kept, {
    cwd: deps.cwd,
    ...(declared !== undefined ? { tags: declared } : {}),
  });
  const exemplary = dropGoodExamples(vetted, parseOptions.guidelinesById);
  if (exemplary.dropped.length > 0) {
    deps.err(
      `${String(exemplary.dropped.length)} finding(s) dropped: the code matches the guideline's own Good example\n`,
    );
  }
  // checked findings sit on the line the check measured; only their suggestions are vetted
  const checked = vetSuggestions(placeFindings(checks?.findings ?? [], linesOfFile), {
    cwd: deps.cwd,
    ...(declared !== undefined ? { tags: declared } : {}),
  });
  const relocated = dedupeFindings([...exemplary.kept, ...checked]);
  // deterministic and therefore allowed to drop outright (ADR 0008, unlike
  // calibration below): refutes a finding whose structural claim -- "this is
  // a loop", "this is top level" -- the AST itself contradicts. Reads source
  // from the checkout, which is exactly the post-change file a diff-relative
  // line number already points into.
  const structural = verifyStructural(relocated, parseOptions.guidelinesById, (file) =>
    readSourceForStructuralCheck(deps.cwd, file),
  );
  const droppedStructural = structural.dropped.length;
  const parsed: ParsedReview = {
    ...executed.parsed,
    findings: structural.kept,
    rejected: [
      ...executed.parsed.rejected,
      ...open.dropped,
      ...(checks?.rejected ?? []),
      ...moved.dropped,
      ...fitted.dropped,
      ...exemplary.dropped,
      ...structural.dropped,
    ],
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
  if (checks?.usage !== undefined) {
    usage = usage === undefined ? checks.usage : addUsage(usage, checks.usage);
  }
  const ensembleMembers = executed.ensembleMembers;
  const toolCalls = executed.toolCalls;
  const cachedResponse = executed.cachedResponse;
  const unparsedBatches = executed.unparsedBatches;

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
      droppedStructural,
      adjustedLines: parsed.adjustedLines,
      droppedMalformed: parsed.droppedMalformed,
      droppedMisquoted: parsed.droppedMisquoted,
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
      droppedStructural,
      adjustedLines: parsed.adjustedLines,
      droppedMalformed: parsed.droppedMalformed,
      droppedMisquoted: parsed.droppedMisquoted,
      redactions: redacted.counts,
      gate,
      ...(usage ? { usage } : {}),
      ...(usage && anyRateConfigured(modelRates(config))
        ? { cost: computeCost(usage, modelRates(config)) }
        : {}),
      ...(ensembleMembers !== undefined
        ? { ensemble: { mode: config.ensemble.mode, members: ensembleMembers } }
        : {}),
      ...(toolCalls !== undefined ? { toolCalls } : {}),
      ...(cachedResponse ? { cachedResponse: true as const } : {}),
      ...(budgetDegraded ? { budgetDegraded: true as const } : {}),
      ...(linters.length > 0 ? { lintersDetected: linters } : {}),
      ...(unparsedBatches.length > 0 ? { unparsedBatches } : {}),
      ...(checks !== undefined ? { checks: checks.tally } : {}),
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
    changedFiles: changedFiles.length,
    commitStatus: config.scm.commitStatus,
    comments: config.scm.comments,
    dryRun: isDryRun(config),
  });

  if (usage !== undefined) {
    deps.err(`${await spendLine(config, usage, now)}\n`);
  }

  if (config.stats.enabled) {
    const rates = modelRates(config);
    // the recorded findings are what survived to the gate, not what was baselined
    await appendRecord(
      deps.cwd,
      config.stats.path,
      ledgerRecords({
        at: now.toISOString(),
        author: commitAuthor(deps.cwd, "HEAD"),
        addedLines: addedLineCount(diff),
        findings: kept,
        misquoted: parsed.droppedMisquoted,
        ...(checks !== undefined && checks.tally.judgeFailed > 0
          ? { judgeFailed: checks.tally.judgeFailed }
          : {}),
        attribution: await pullRequestAttribution(deps, config),
        ...(config.model.id !== undefined ? { model: config.model.id } : {}),
        ...(usage !== undefined ? { usage } : {}),
        ...(usage !== undefined && anyRateConfigured(rates)
          ? { cost: computeCost(usage, rates).total }
          : {}),
        durationMs: Math.round(performance.now() - startedAt),
      }),
    );
    deps.err(`stats: review recorded in ${config.stats.path}\n`);
  }

  return gate.failed ? 2 : 0;
}

/**
 * Records the spend when rates are set and returns the one log line a run
 * prints about it: tokens in and out, the cost, and the month on the counter.
 */
export async function spendLine(config: Config, usage: ModelUsage, now: Date): Promise<string> {
  // the model id shows which rates priced the run, an env override included
  const tokens = `${String(usage.inputTokens)} tokens in, ${String(usage.outputTokens)} out on ${config.model.id ?? "(unset model)"}`;
  const rates = modelRates(config);
  if (!anyRateConfigured(rates)) return `usage: ${tokens}; no cost rates configured`;
  const spent = computeCost(usage, rates).total;
  const counterPath = config.cost.counterPath ?? defaultCounterPath();
  const month = monthKey(now);
  await recordSpend(counterPath, month, spent);
  const cap = config.cost.monthlyCap > 0 ? ` of ${String(config.cost.monthlyCap)}` : "";
  return `cost: ${tokens}, ${usd(spent)} USD; ${month} spend ${usd(readMonthSpend(counterPath, month))} USD${cap} on ${counterPath}`;
}

/** PR number, link and title for the ledger; a host that cannot say leaves them out. */
export async function pullRequestAttribution(
  deps: ReviewDeps,
  config: Config,
): Promise<Attribution> {
  let text: PullRequestText | undefined;
  if (config.scm.provider !== "local") {
    try {
      const scm = deps.scmPort ?? buildScmPort(config, deps.credentials, deps.ciBuildUrl);
      text = await scm.getPullRequestText?.();
    } catch (error) {
      deps.err(
        `stats: pull request title unavailable (${String((error as Error).message.split("\n")[0])})\n`,
      );
    }
  }
  const number = config.scm.pullRequest;
  return attributionOf(
    {
      ...(number !== undefined ? { number } : {}),
      ...(text?.url !== undefined ? { url: text.url } : {}),
    },
    text?.title,
  );
}

function usd(amount: number): string {
  return amount.toFixed(4);
}

/**
 * A file's lines at the reviewed commit (the index for a staged review), then
 * the working tree, then the lines the diff itself shows.
 */
export function linesAtHead(
  cwd: string,
  file: string,
  fromDiff: ReadonlyMap<number, string> | undefined,
  staged = false,
): readonly string[] | undefined {
  try {
    return runGit(cwd, ["show", `${staged ? "" : "HEAD"}:${file}`]).split("\n");
  } catch {
    // not in git: fall through to the checkout and then the diff
  }
  const fromDisk = readSourceForStructuralCheck(cwd, file);
  if (fromDisk !== undefined) return fromDisk.split("\n");
  return fromDiff === undefined ? undefined : linesFromDiff(fromDiff);
}

/** The checkout's current text of a finding's file, for the structural verifier; undefined if unreadable. */
export function readSourceForStructuralCheck(cwd: string, file: string): string | undefined {
  try {
    return readFileSync(path.resolve(cwd, file), "utf8");
  } catch {
    return undefined; // deleted, renamed away, or otherwise unreadable at review time
  }
}

/** One model call the review makes: one diff batch with its context and tools. */
export interface PlannedPass {
  label: string;
  request: ModelRequest;
}

export type PromptOf = (diffText: string, context: string) => ModelRequest;

/**
 * Every call a review makes, in order. Each batch carries its own context and
 * the same tools, so no batch is where a strategy silently stops running.
 */
export function planPasses(
  config: Config,
  diffBatches: readonly string[],
  batchContexts: readonly string[],
  contextTools: ToolSet | undefined,
  promptOf: PromptOf,
): PlannedPass[] {
  return diffBatches.map((batchDiff, index) => ({
    label: `batch ${String(index + 1)}/${String(diffBatches.length)}`,
    request: attachContextTools(
      promptOf(batchDiff, batchContexts[index] ?? ""),
      contextTools,
      config.context.maxToolRounds,
    ),
  }));
}

interface AssembledReview {
  redacted: RedactedDiff;
  /** The whole-corpus request: what an ensemble sends and the shape a single pass takes. */
  request: ModelRequest;
  passes: PlannedPass[];
  batchCount: number;
  parseOptions: ParseOptions;
  budgetDegraded: boolean;
  linters: string[];
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
  declared: DeclaredTags | undefined,
): Promise<AssembledReview> {
  const redacted = redactDiff(diff, compileCustomPatterns(config.redaction.patterns), {
    strict: config.redaction.strict,
  });
  const redactionTotal = Object.values(redacted.counts).reduce((sum, n) => sum + n, 0);
  if (redactionTotal > 0) {
    deps.err(`${String(redactionTotal)} secret-shaped value(s) redacted before the model call\n`);
  }

  const contextInput = { cwd: deps.cwd, diff: redacted.text, changedFiles: [...changedFiles] };
  const resolvedContext = await resolveContext(
    config,
    {
      credentials: deps.credentials,
      ...(deps.embeddingPort ? { embeddingPort: deps.embeddingPort } : {}),
      ...(deps.clock ? { clock: deps.clock } : {}),
    },
    contextInput,
  );
  for (const notice of resolvedContext.notices) deps.err(`${notice}\n`);
  const projectContext = resolvedContext.projectContext;
  const contextTools = resolvedContext.tools;

  const linters = detectLinters(deps.cwd);
  if (linters.length > 0) deps.err(`linters detected (not duplicated): ${linters.join(", ")}\n`);
  const promptOf: PromptOf = (diffText, context) =>
    buildReviewPrompt(guidelines, diffText, {
      generalPass: config.review.generalPass,
      language: config.review.language,
      linterInstruction: linterInstruction(linters),
      ...(declared !== undefined ? { declarations: declaredTagsBlock(declared) } : {}),
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
  // is still too big to afford context with tools bolted on. Packing reserves
  // room for prefix + context in every batch, so each batch gets its own
  // context decision instead of one drop-for-everyone verdict, and splitting
  // the diff is not, by itself, a reason to call the review degraded.
  const batches = planBatches(
    plan,
    redacted.text,
    projectContext,
    prefix,
    config.review.windowTokens,
    {
      maxFiles: config.review.maxFilesPerBatch,
      maxTokens: config.review.maxTokensPerBatch,
    },
  );
  for (const notice of batches.notices) deps.err(`${notice}\n`);
  const { diffBatches, batchContexts, degraded: budgetDegraded } = batches;

  const request = attachContextTools(
    promptOf(diffBatches[0] ?? redacted.text, batchContexts[0] ?? ""),
    contextTools,
    config.context.maxToolRounds,
  );
  const parseOptions = {
    guidelinesById: new Map(guidelines.map((guideline) => [guideline.id, guideline])),
    generalPass: config.review.generalPass,
    observationSeverityCap: config.review.observationSeverityCap,
  };
  return {
    redacted,
    request,
    passes: planPasses(config, diffBatches, batchContexts, contextTools, promptOf),
    batchCount: diffBatches.length,
    parseOptions,
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
  /** Batches whose reply could not be parsed; every other batch's findings still stand. */
  unparsedBatches: UnparsedBatch[];
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
  passes: readonly PlannedPass[],
  batchCount: number,
  parseOptions: ParseOptions,
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
      unparsedBatches: [],
    };
  }

  const modelPort = reviewPort(deps, config);
  if (batchCount > 1) {
    deps.err(`budget: reviewing the diff in ${String(batchCount)} batch(es)\n`);
  }
  return {
    ...(await runPasses(deps, modelPort, passes, parseOptions)),
    ensembleMembers: undefined,
  };
}

/** The review's model behind the response cache; the open passes and the judge share it. */
function reviewPort(deps: ReviewDeps, config: Config): ModelPort {
  return withResponseCache(
    deps.modelPort ?? buildModelPort(config, deps.credentials),
    config,
    deps.cwd,
    () => deps.clock?.() ?? new Date(),
    (notice) => {
      deps.err(`${notice}\n`);
    },
  );
}

/** Passes in flight at once; a focused review fans out one call per guideline. */
const PASS_CONCURRENCY = 4;

type PassOutcome =
  { ok: true; parsed: ParsedReview; reply: ModelReply } | { ok: false; reason: string };

/**
 * Runs every planned pass and folds the replies into one parsed result. A
 * reply with no parseable JSON gets one more answering step, then costs only
 * its own pass's findings: the others were paid for and stand beside it.
 */
export async function runPasses(
  deps: Pick<ReviewDeps, "err">,
  modelPort: ModelPort,
  passes: readonly PlannedPass[],
  parseOptions: ParseOptions,
): Promise<Omit<ExecuteResult, "ensembleMembers">> {
  const outcomes = await inPool(
    passes.map((pass) => async (): Promise<PassOutcome> => {
      let reply = await completeOrFail(modelPort, pass.request);
      try {
        try {
          return { ok: true, parsed: parseReviewResponse(reply.text, parseOptions), reply };
        } catch (error) {
          // one more answering step, tools off, with what the model fetched replayed as text
          deps.err(
            `${pass.label}: ${(error as Error).message}; asking once more for the JSON answer\n`,
          );
          const first = reply;
          reply = await completeOrFail(modelPort, retryRequest(pass.request, first));
          reply = {
            ...reply,
            ...(first.usage !== undefined
              ? { usage: reply.usage ? addUsage(first.usage, reply.usage) : first.usage }
              : {}),
            ...(first.toolCalls !== undefined ? { toolCalls: first.toolCalls } : {}),
          };
          return { ok: true, parsed: parseReviewResponse(reply.text, parseOptions), reply };
        }
      } catch (error) {
        const reason = (error as Error).message;
        deps.err(`${pass.label}: ${reason}; skipping this batch's findings\n`);
        return { ok: false, reason };
      }
    }),
    PASS_CONCURRENCY,
  );
  const merged: Finding[] = [];
  let usage: ModelUsage | undefined;
  let toolCalls: number | undefined;
  let cachedResponse = false;
  const counts = { uncited: 0, outOfScope: 0, adjusted: 0, malformed: 0, misquoted: 0 };
  const rejected: RejectedCandidate[] = [];
  const unparsedBatches: UnparsedBatch[] = [];
  for (const [index, outcome] of outcomes.entries()) {
    if (!outcome.ok) {
      unparsedBatches.push({ batch: index + 1, of: passes.length, reason: outcome.reason });
      continue;
    }
    const { parsed, reply } = outcome;
    merged.push(...parsed.findings);
    counts.uncited += parsed.droppedUncited;
    counts.outOfScope += parsed.droppedOutOfScope;
    counts.adjusted += parsed.adjustedLines;
    counts.malformed += parsed.droppedMalformed;
    counts.misquoted += parsed.droppedMisquoted;
    rejected.push(...parsed.rejected);
    usage = usage ? (reply.usage ? addUsage(usage, reply.usage) : usage) : reply.usage;
    if (reply.toolCalls !== undefined && reply.toolCalls > 0) {
      toolCalls = (toolCalls ?? 0) + reply.toolCalls;
    }
    if (reply.cached === true) cachedResponse = true;
  }
  if (toolCalls !== undefined) {
    deps.err(`agentic context: ${String(toolCalls)} tool call(s) served\n`);
  }
  if (unparsedBatches.length === passes.length) {
    // every pass failed to parse: zero findings here would read as a clean
    // pass, so this must surface exactly like the old single-batch failure did
    throw new ToolError(
      [
        "every batch's reply failed to parse; nothing to review with",
        ...unparsedBatches.map(
          (entry) =>
            `${passes[entry.batch - 1]?.label ?? `pass ${String(entry.batch)}`}: ${entry.reason}`,
        ),
      ].join("\n"),
    );
  }
  return {
    parsed: {
      // same file + line + guidelineId is the same finding whichever pass or
      // batch found it, and one reply can cite a guideline twice in other words
      findings: dedupeFindings(merged),
      droppedUncited: counts.uncited,
      droppedOutOfScope: counts.outOfScope,
      adjustedLines: counts.adjusted,
      droppedMalformed: counts.malformed,
      droppedMisquoted: counts.misquoted,
      rejected,
    },
    usage,
    toolCalls,
    cachedResponse,
    unparsedBatches,
  };
}

async function completeOrFail(port: ModelPort, request: ModelRequest): Promise<ModelReply> {
  try {
    return await port.complete(request);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(`model call failed: ${(error as Error).message}`);
  }
}

/**
 * The retry of an answering step whose reply held no JSON: the same prompt,
 * the tool results the model had fetched as text, its own reply, and one
 * instruction to answer in the requested shape. No tools, so it must answer.
 */
export function retryRequest(request: ModelRequest, reply: ModelReply): ModelRequest {
  return {
    system: request.system,
    user: [
      withFetched(request.user, reply.transcript),
      "",
      "Your previous reply:",
      "<reply>",
      reply.text,
      "</reply>",
      "",
      'That reply held no JSON answer. Reply now with the JSON object only, in the shape requested above; if nothing violates a guideline reply {"findings": []}.',
    ].join("\n"),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
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
  const scm = deps.scmPort ?? buildScmPort(config, deps.credentials, deps.ciBuildUrl);
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
async function publishAllClear(deps: ReviewDeps, config: Config, line: string): Promise<void> {
  await publishIfConfigured(deps, config, {
    findings: [],
    proposals: [],
    droppedUncited: 0,
    filtered: 0,
    gate: evaluateGate([], config.gate.failOn),
    outcome: { kind: "not-reviewed", line },
    commitStatus: config.scm.commitStatus,
    comments: config.scm.comments,
    dryRun: isDryRun(config),
  });
}

/**
 * A run that broke off still speaks: the summary says the review could not
 * complete and the status fails, instead of the pipeline dying in silence.
 */
async function publishFailure(deps: ReviewDeps, config: Config, reason: string): Promise<void> {
  try {
    await publishIfConfigured(deps, config, {
      findings: [],
      proposals: [],
      droppedUncited: 0,
      filtered: 0,
      gate: evaluateGate([], config.gate.failOn),
      outcome: { kind: "failed", reason },
      commitStatus: config.scm.commitStatus,
      comments: config.scm.comments,
      dryRun: isDryRun(config),
    });
  } catch (error) {
    deps.err(
      `could not post the failure summary: ${String((error as Error).message.split("\n")[0])}\n`,
    );
  }
}

/** A run the cost guard stopped says so on the pull request instead of staying silent. */
async function publishSkipped(deps: ReviewDeps, config: Config, reason: string): Promise<void> {
  await publishIfConfigured(deps, config, {
    findings: [],
    proposals: [],
    droppedUncited: 0,
    filtered: 0,
    gate: evaluateGate([], config.gate.failOn),
    outcome: { kind: "capped", reason },
    commitStatus: config.scm.commitStatus,
    comments: config.scm.comments,
    dryRun: isDryRun(config),
  });
}

/** Which cap stopped the run, in words a pull request reader follows. */
export function capReason(reasons: readonly string[]): string {
  return reasons.some((reason) => reason.includes("monthlyCap"))
    ? "the monthly cost cap is reached"
    : "this change would cost more than the per review cap";
}

/** The first line of a failure, readable on a pull request. */
function failureReason(error: ToolError): string {
  const first = String(error.message.split("\n")[0]);
  if (/held no JSON|not valid JSON|failed to parse|expected shape/.test(error.message)) {
    return "the model's reply held no readable findings, twice";
  }
  return first;
}

/** A review whose every applicable guideline is checked makes no open call. */
function idleExecution(): ExecuteResult {
  return {
    parsed: {
      findings: [],
      droppedUncited: 0,
      droppedOutOfScope: 0,
      adjustedLines: 0,
      droppedMalformed: 0,
      droppedMisquoted: 0,
      rejected: [],
    },
    usage: undefined,
    ensembleMembers: undefined,
    toolCalls: undefined,
    cachedResponse: false,
    unparsedBatches: [],
  };
}

/** The repository's tracked files, for following a method to its body; empty outside git. */
export function trackedFiles(cwd: string): string[] {
  try {
    return runGit(cwd, ["ls-files"])
      .split("\n")
      .filter((file) => file !== "" && !/(?:^|\/)(?:node_modules|dist)\//.test(file));
  } catch {
    return [];
  }
}

/** The checked out commit, short; undefined outside a git checkout. */
function reviewedCommit(cwd: string): string | undefined {
  try {
    return runGit(cwd, ["rev-parse", "--short=12", "HEAD"]).trim();
  } catch {
    return undefined;
  }
}

/** The branch links point at: the target without a remote or refs prefix. */
function targetBranch(target: string): string {
  return target.replace(/^refs\/heads\//, "").replace(/^origin\//, "");
}

async function publishIfConfigured(
  deps: ReviewDeps,
  config: Config,
  input: Omit<
    Parameters<typeof publishReview>[1],
    "codeInsights" | "presentation" | "tasks" | "lineTextOf"
  >,
): Promise<void> {
  if (config.scm.provider === "local") return;
  // publishReview itself holds the hard guarantee now: a dry run trips zero
  // adapter writes even if this caller got the plumbing wrong.
  const scm = deps.scmPort ?? buildScmPort(config, deps.credentials, deps.ciBuildUrl);
  const { guidePath } = config.review;
  const lines = new Map<string, readonly string[] | undefined>();
  const head = reviewedCommit(deps.cwd);
  const outcome = await publishReview(scm, {
    ...input,
    ...(head !== undefined ? { resolvedIn: head } : {}),
    tasks: config.scm.tasks,
    lineTextOf: (file, line) => {
      if (!lines.has(file)) lines.set(file, linesAtHead(deps.cwd, file, undefined));
      return lines.get(file)?.[line - 1];
    },
    codeInsights: codeInsightsEnabled(config),
    summaryWhenClean: config.review.summaryWhenClean,
    presentation: {
      displayName: config.review.displayName,
      guidelinesDir: config.review.guidelinesDir,
      targetBranch: targetBranch(config.review.target),
      ...(existsSync(path.resolve(deps.cwd, guidePath)) ? { guidePath } : {}),
    },
  });
  for (const notice of outcome.notices) deps.err(`${notice}\n`);
  if (!input.dryRun) {
    deps.err(
      `published: ${String(outcome.created)} created, ${String(outcome.updated)} updated, ${String(outcome.deleted)} resolved, ${String(outcome.unchanged)} unchanged\n`,
    );
    if (outcome.tasksCreated !== undefined || outcome.tasksResolved !== undefined) {
      deps.err(
        `tasks: ${String(outcome.tasksCreated ?? 0)} created, ${String(outcome.tasksResolved ?? 0)} resolved\n`,
      );
    }
  }
}
