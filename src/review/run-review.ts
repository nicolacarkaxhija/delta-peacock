import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ToolSet } from "ai";
import type { Config } from "../config/schema.js";
import { attachContextTools, resolveContext } from "../context/build.js";
import type { RuntimeDeps } from "../deps.js";
import { fingerprintOf, type Finding } from "../domain/finding.js";
import type { Guideline } from "../domain/guideline.js";
import { evaluateGate } from "../domain/gate.js";
import { ToolError } from "../errors.js";
import {
  acquireDiff,
  addedLineCount,
  changedFilesFromDiff,
  commitAuthor,
  filterDiffByPath,
  scopeOfFiles,
  type ChangeScope,
  LocalDiffUnavailableError,
  newLineTexts,
  resolveTargetRef,
  stagedDiff,
  type AcquiredDiff,
} from "../git/diff.js";
import { appliesTo } from "../guidelines/languages.js";
import { resolveGuidelines, type ResolvedGuidelines } from "../guidelines/loader.js";
import { guidelineSources } from "./guideline-sources.js";
import { buildModelPort, noModel } from "../model/build.js";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  type ModelPort,
  type ModelReply,
  type ModelRequest,
  type ModelUsage,
} from "../model/port.js";
import { withFetched } from "../model/generate.js";
import {
  anyRateConfigured,
  computeCost,
  modelRates,
  ratesFor,
  type CostRates,
} from "../model/usage.js";
import {
  OUTPUT_CAP_HIT,
  OUTPUT_CAP_RETRY_FACTOR,
  hitOutputCap,
  outputCapFor,
} from "./output-cap.js";
import { ceilingReason, metered, spendCeiling } from "../cost/ceiling.js";
import { checkCostGuard, guardActive } from "../cost/guard.js";
import { defaultCounterPath, monthKey, readMonthSpend, recordSpend } from "../cost/counter.js";
import { addUsage } from "../model/usage.js";
import { buildModelPortFor } from "../model/build.js";
import {
  fallsBack as fallsBackOn,
  ModelUnavailableError,
  unavailability,
  type ModelUnavailability,
} from "../model/unavailable.js";
import type { RetryOptions } from "../model/retry.js";
import { withResponseCache } from "../model/cache.js";
import { renderCodeQuality, renderSarif } from "./artifacts.js";
import { fingerprintsOf, writeFindingsFile } from "./findings-file.js";
import { writeReviewRecord } from "./review-record.js";
import { halveDiff, planBatches, planBudget, promptBudget } from "./budget.js";
import { detectLinters, linterInstruction } from "./linters.js";
import { loadBaseline, splitByBaseline, writeBaseline } from "./baseline.js";
import { calibrate } from "./calibrate.js";
import { dedupeFindings, runEnsemble, type MemberOutcome } from "./ensemble.js";
import { keepOnChangedLines } from "./changed-lines.js";
import { partitionAccepted, readAcceptedForms } from "./accepted-forms.js";
import { applyExclusions } from "./exclusions.js";
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
  dropAlreadyHeld,
  dropGoodExamples,
  dropUnfitTags,
  linesFromDiff,
  placeFindings,
  vetSuggestions,
} from "./placement.js";
import { runGit } from "../git/git.js";
import {
  factsLine,
  fallbackReason,
  NOT_REVIEWED,
  unavailableReason,
  type FactsScope,
} from "../scm/comment-format.js";
import { buildScmPort } from "../scm/build.js";
import { codeInsightsEnabled, isDryRun, publishReview } from "../scm/publish.js";
import { compileCustomPatterns, redactDiff, type RedactedDiff } from "./redact.js";
import { renderReview } from "./render.js";
import { harvestUncited } from "./harvest.js";
import { findWaiver, parseWaivers, type Waiver } from "./waiver.js";
import {
  buildReport,
  type FactsOnly,
  type ReviewReport,
  type SemgrepTally,
  type UnparsedBatch,
  type WaivedFinding,
} from "./report.js";
import { verifyStructural } from "./structural.js";
import { writeDrafts } from "../guidelines/draft.js";
import type { PullRequestText } from "../scm/port.js";
import { appendRecord, attributionOf, ledgerRecords, type Attribution } from "../stats/record.js";
import { checkSentenceProblems, dropChecked, runChecks, splitChecked } from "./checks/index.js";
import type { ModelOutage } from "./checks/judge.js";
import { ConfigError } from "../config/loader.js";
import { runPrepass, type PrepassOutcome } from "./semgrep/prepass.js";
import { MS_PER_SECOND, semgrepRunner } from "./semgrep/run.js";

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
  // an earlier review's findings never outlive a run that stops or throws
  if (config.output.findingsDir !== undefined) {
    writeFindingsFile(deps.cwd, config.output.findingsDir, []);
  }

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
  const sources: PublishSources = { guidelines: loaded, targetRef: resolvedTarget.ref };
  // a check posts only a sentence its guideline really says
  const unquotable = checkSentenceProblems(loaded.guidelines, config.review.checks);
  if (unquotable.length > 0) throw new ConfigError(unquotable);
  if (loaded.guidelines.length === 0 && options.bootstrap !== true) {
    deps.out("no usable guidelines found; nothing to review against\n");
    await publishAllClear(deps, config, NOT_REVIEWED.noGuidelines, sources);
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
    await publishAllClear(deps, config, NOT_REVIEWED.tooLarge, sources);
    return 0;
  }
  const diff = acquired.text;
  if (diff.trim() === "") {
    deps.out(`nothing to review: no changes against ${acquired.targetRef}\n`);
    await publishAllClear(deps, config, NOT_REVIEWED.nothingInScope, sources, acquired.scope);
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
    await publishAllClear(deps, config, NOT_REVIEWED.noneApply, sources, acquired.scope);
    return 0;
  }

  const declared = readDeclaredTags(deps.cwd, config.review.repoConfigPath);
  // a checked guideline yields findings only on the lines its static check flags;
  // the open prompt still shows it, so the open review reads the same corpus
  const { bound, free } = splitChecked(guidelines, config.review.checks);
  // an API diff means the checkout is not the pull request; only the diff knows its lines
  const fromApi = acquired.targetRef === "scm api";
  const linesFrom =
    (texts: ReadonlyMap<string, ReadonlyMap<number, string>>) =>
    (file: string): readonly string[] | undefined => {
      const known = texts.get(file);
      if (fromApi) return known === undefined ? undefined : linesFromDiff(known);
      return linesAtHead(deps.cwd, file, known, options.staged === true);
    };
  // the rules run before the model; what they settle the model never receives
  const prepass = config.semgrep.enabled
    ? await runPrepass({
        guidelines,
        diff,
        read: linesFrom(newLineTexts(diff)),
        generalPass: config.review.generalPass,
        runner:
          deps.semgrepRunner ??
          semgrepRunner({
            command: config.semgrep.command,
            timeoutMs: config.semgrep.timeoutSeconds * MS_PER_SECOND,
          }),
      })
    : undefined;
  if (prepass !== undefined) logPrepass(deps, prepass);
  const settled = new Set(prepass?.settled ?? []);
  const judged = guidelines.filter((guideline) => !settled.has(guideline.id));
  const modelFree = free.filter((guideline) => !settled.has(guideline.id));
  const factsOnly = noModel(config);
  const { redacted, request, passes, batchCount, parseOptions, budgetDegraded, linters } = factsOnly
    ? assembleFacts(deps, config, diff, guidelines)
    : await assembleReview(deps, config, diff, prepass?.modelDiff ?? diff, judged, declared);
  if (factsOnly) {
    deps.err(
      `facts only: model.provider is none; ${String(bound.length + settled.size)} checked guideline(s) reviewed, ${String(modelFree.length)} not reviewed${modelFree.length > 0 ? `: ${modelFree.map((one) => one.id).join(", ")}` : ""}\n`,
    );
  }

  const now = deps.clock?.() ?? new Date();
  // set when the cost guard stops the model part; the facts still run and post
  let blocked: ReviewReport["budget"];
  // an ensemble sends one wave of calls, so only its estimate can be capped
  let limit = Number.POSITIVE_INFINITY;
  if (!factsOnly && guardActive(config)) {
    const decision = await checkCostGuard(config, request, now, {
      batches: batchCount,
      // an ensemble sends the whole request at the plain cap; passes ask for their own
      ...(config.ensemble.enabled
        ? {}
        : {
            outputCaps: passes.map((pass) =>
              outputCapFor(pass.files.length, config.review.maxOutputTokens),
            ),
          }),
      basis: config.ensemble.enabled ? "estimate" : "actual",
    });
    for (const notice of decision.notices) deps.err(`${notice}\n`);
    limit = decision.limit;
    if (!decision.allowed) {
      for (const reason of decision.reasons) deps.out(`budget: ${reason}\n`);
      deps.out("review blocked by the cost guard before any model call; checking facts only\n");
      blocked = {
        blocked: true,
        ...(decision.monthToDate !== undefined ? { monthToDate: decision.monthToDate } : {}),
        reasons: decision.reasons,
      };
    }
  }
  const ceiling = spendCeiling(limit, modelRates(config));
  let meteredPort: ModelPort | undefined;
  // the batches, the judge and the exclusion check spend from one ceiling
  const modelPort = (): ModelPort => (meteredPort ??= metered(reviewPort(deps, config), ceiling));
  const verdictRef = config.exclusions.model;
  let verdictPort: ModelPort | undefined;
  // a model set for the verdicts alone spends from the same ceiling at its own rates
  const exclusionPort = (): ModelPort =>
    verdictRef === undefined
      ? modelPort()
      : (verdictPort ??= metered(
          deps.modelPortFor?.(verdictRef) ??
            buildModelPortFor(
              verdictRef,
              deps.credentials,
              config.model.timeoutSeconds,
              retryOf(deps),
            ),
          ceiling,
          ratesFor(config.cost, verdictRef.id),
        ));

  let executed: ExecuteResult;
  // with every applicable guideline checked, an open call could only produce what is dropped
  const allChecked =
    modelFree.length === 0 && bound.length + settled.size > 0 && !config.review.generalPass;
  // set when a configured model cannot run: the review falls back to facts only
  let fallback: ModelOutage | undefined;
  // what a model reviewed before it could not run; unset when it reviewed nothing
  let modelReviewed: "part" | "all" | undefined;
  // fallback.credentialRefused fail: a refused credential fails the run as before
  const fallsBack = (why: ModelUnavailability): boolean => fallsBackOn(why, config.fallback);
  if (blocked !== undefined) fallback = { why: "cost-cap", detail: blocked.reasons.join("; ") };
  try {
    if (allChecked && !factsOnly && blocked === undefined) {
      deps.err("every applicable guideline is checked; no open review call\n");
    }
    executed =
      allChecked || factsOnly || blocked !== undefined
        ? idleExecution()
        : await executeReview(deps, config, modelPort, request, passes, batchCount, parseOptions);
    if (executed.outage !== undefined) {
      const { why, detail } = executed.outage;
      if (!fallsBack(why)) throw new ModelUnavailableError(why, detail);
      fallback = executed.outage;
      modelReviewed = "part";
      logFallback(deps, fallback);
    }
  } catch (error) {
    if (!(error instanceof ModelUnavailableError) || !fallsBack(error.why)) {
      if (error instanceof ToolError) await publishFailure(deps, config, failureReason(error));
      throw error;
    }
    fallback = { why: error.why, detail: error.message };
    logFallback(deps, fallback);
    executed = idleExecution();
  }
  // no model answered all of the open review: the guidelines no check owns got no full review
  const noOpenReview = factsOnly || fallback !== undefined;
  // the model counts line numbers by hand and drifts; each finding moves to
  // the line it quotes, or to no line at all, before anything keys on line
  const diffLines = newLineTexts(redacted.text);
  const linesOfFile = linesFrom(diffLines);
  const open = dropChecked(executed.parsed.findings, bound);
  if (open.dropped.length > 0) {
    deps.err(
      `${String(open.dropped.length)} finding(s) dropped: their guideline is checked, and only its check's lines count\n`,
    );
  }
  // two findings that quote one line under one guideline are one finding
  // a diff review judges the change: a finding on hunk context alone is not about it
  const onChange = keepOnChangedLines(
    dedupeFindings(placeFindings(open.kept, linesOfFile)),
    diffLines,
    parseOptions.guidelinesById,
  );
  const placed = onChange.kept;
  // a case the guideline says is never a finding is held against every finding it could excuse
  const excluded =
    noOpenReview || placed.length === 0
      ? undefined
      : await applyExclusions(placed, {
          port: exclusionPort,
          guidelinesById: parseOptions.guidelinesById,
          linesOf: linesOfFile,
          concurrency: PASS_CONCURRENCY,
        });
  for (const notice of excluded?.notices ?? []) deps.err(`${notice}\n`);
  if (excluded !== undefined && excluded.dropped.length > 0) {
    deps.err(
      `${String(excluded.dropped.length)} finding(s) dropped: their guideline says the line is never a finding\n`,
    );
  }
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
          ...(noOpenReview ? {} : { port: modelPort }),
          redact: (text) =>
            redactDiff(text, compileCustomPatterns(config.redaction.patterns), {
              strict: config.redaction.strict,
            }).text,
          credentialRefused: config.fallback.credentialRefused,
        })
      : undefined;
  for (const notice of checks?.notices ?? []) deps.err(`${notice}\n`);
  if (fallback === undefined && checks?.unavailable !== undefined) {
    if (!fallsBack(checks.unavailable.why)) {
      const error = new ModelUnavailableError(checks.unavailable.why, checks.unavailable.detail);
      await publishFailure(deps, config, failureReason(error));
      throw error;
    }
    fallback = checks.unavailable;
    // the open review answered; only the judge could not run
    if (!allChecked) modelReviewed = "all";
    logFallback(deps, fallback);
  }
  // a fix that only repeats a reason already written just above is no fix
  const reviewedLines = (file: string): readonly string[] | undefined =>
    fromApi
      ? linesFromDiff(diffLines.get(file) ?? new Map<number, string>())
      : linesAtHead(deps.cwd, file, diffLines.get(file), options.staged === true);
  const moved = dropCommentMoves(excluded?.kept ?? placed, reviewedLines);
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
  const held = dropAlreadyHeld(exemplary.kept);
  if (held.dropped.length > 0) {
    deps.err(
      `${String(held.dropped.length)} finding(s) dropped: the line already holds the text they ask for\n`,
    );
  }
  // checked findings sit on the line the check measured; only their suggestions are vetted
  const checked = vetSuggestions(placeFindings(checks?.findings ?? [], linesOfFile), {
    cwd: deps.cwd,
    ...(declared !== undefined ? { tags: declared } : {}),
  });
  // a rule finding goes first, so it stands where the model found the same line
  const relocated = dedupeFindings([...(prepass?.findings ?? []), ...held.kept, ...checked]);
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
      ...onChange.dropped,
      ...(excluded?.dropped ?? []),
      ...(checks?.rejected ?? []),
      ...moved.dropped,
      ...fitted.dropped,
      ...exemplary.dropped,
      ...held.dropped,
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
  // verdicts on their own model are priced apart; on the review model they join its usage
  const verdicts: VerdictSpend | undefined =
    verdictRef !== undefined && excluded?.usage !== undefined
      ? { id: verdictRef.id, usage: excluded.usage, rates: ratesFor(config.cost, verdictRef.id) }
      : undefined;
  if (verdicts === undefined && excluded?.usage !== undefined) {
    usage = usage === undefined ? excluded.usage : addUsage(usage, excluded.usage);
  }
  if (checks?.usage !== undefined) {
    usage = usage === undefined ? checks.usage : addUsage(usage, checks.usage);
  }
  // no model ran, so the run records zero tokens rather than nothing
  if (factsOnly) usage = { inputTokens: 0, outputTokens: 0 };
  const facts: FactsOnly | undefined =
    factsOnly || fallback !== undefined
      ? {
          leftToPerson: checks?.left ?? [],
          notReviewed: noOpenReview ? modelFree.map((one) => one.id) : [],
          ...(fallback !== undefined ? { fallback: fallback.why } : {}),
          ...(modelReviewed !== undefined ? { modelReviewed } : {}),
          ...(executed.unjudgedFiles !== undefined
            ? { unjudgedFiles: executed.unjudgedFiles }
            : {}),
        }
      : undefined;
  const ensembleMembers = executed.ensembleMembers;
  const toolCalls = executed.toolCalls;
  const cachedResponse = executed.cachedResponse;
  const unparsedBatches = executed.unparsedBatches;
  // no reply could be read for these: the run names them and passes or warns per fallback.status
  const cappedFiles = [
    ...new Set(
      unparsedBatches.filter((entry) => entry.reason === OUTPUT_CAP_HIT).flatMap((e) => e.files),
    ),
  ];
  const unparsedFiles = [...new Set(unparsedBatches.flatMap((entry) => entry.files))];
  if (unparsedFiles.length > 0) {
    const of = changedFiles.length;
    const unreadable = unparsedFiles.filter((file) => !cappedFiles.includes(file));
    const named = [
      ...(unreadable.length > 0 ? [`reply unparseable: ${unreadable.join(", ")}`] : []),
      ...(cappedFiles.length > 0 ? [`${OUTPUT_CAP_HIT}: ${cappedFiles.join(", ")}`] : []),
    ];
    deps.err(
      `reviewed ${String(of - unparsedFiles.length)} of ${String(of)} file${of === 1 ? "" : "s"}; not reviewed: ${named.join("; ")}\n`,
    );
  }

  const finalized = await finalizeFindings(
    deps,
    config,
    options,
    parsed.findings,
    redacted.text,
    usage,
    ceiling.reached(),
  );
  const filtered = finalized.filtered;
  const baselined = finalized.baselined;
  usage = finalized.usage;
  // an in-code waiver moves a violation out of the gate but not out of the report
  const waivers = parseWaivers(newLineTexts(redacted.text)).waivers;
  const waived: { finding: Finding; waiver: Waiver }[] = [];
  const kept: Finding[] = [];
  // a form the repository listed as accepted is never posted, only counted
  const forms = readAcceptedForms(deps.cwd, loaded.origin, config.review.guidelinesDir);
  const { kept: unaccepted, accepted } = partitionAccepted(finalized.kept, forms);
  for (const finding of unaccepted) {
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
  const unjudged = new Set(
    [...placeFindings(checks?.facts ?? [], linesOfFile), ...(prepass?.findings ?? [])].map(
      fingerprintOf,
    ),
  );
  // fallback.gate pass: in an outage no fact fails the step, a model's finding still does
  const gate = evaluateGate(
    fallback !== undefined && config.fallback.gate === "pass"
      ? kept.filter((finding) => !unjudged.has(fingerprintOf(finding)))
      : kept,
    config.gate.failOn,
  );

  deps.out(
    renderReview({
      violations,
      observations,
      proposals,
      droppedUncited: parsed.droppedUncited,
      droppedOutOfScope: parsed.droppedOutOfScope,
      droppedStructural,
      droppedOffChange: onChange.dropped.length,
      adjustedLines: parsed.adjustedLines,
      droppedMalformed: parsed.droppedMalformed,
      droppedMisquoted: parsed.droppedMisquoted,
      filtered: filtered.length,
      accepted: accepted.length,
      waived: waivedEntries,
      gate,
    }),
  );
  if (facts !== undefined) {
    for (const left of facts.leftToPerson) {
      deps.out(
        `left to a person: needs a judgement: ${left.file}:${String(left.line)} [${left.guidelineId}] ${left.question}\n`,
      );
    }
    deps.out(`${factsLine(kept.length, factsScope(facts, config))}\n`);
  }

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
    config.output.codeQualityPath !== undefined ||
    config.output.findingsDir !== undefined;
  if (wantsArtifacts) {
    const anchorTexts = newLineTexts(redacted.text);
    const report = buildReport({
      lineTextOf: (finding) => anchorTexts.get(finding.file)?.get(finding.line),
      findings: kept,
      baselined,
      ...(waivedEntries.length > 0 ? { waived: waivedEntries } : {}),
      ...(parsed.rejected.length > 0 ? { rejected: parsed.rejected } : {}),
      filtered,
      ...(accepted.length > 0 ? { accepted } : {}),
      proposals,
      droppedUncited: parsed.droppedUncited,
      droppedOutOfScope: parsed.droppedOutOfScope,
      droppedStructural,
      droppedOffChange: onChange.dropped.length,
      adjustedLines: parsed.adjustedLines,
      droppedMalformed: parsed.droppedMalformed,
      droppedMisquoted: parsed.droppedMisquoted,
      redactions: redacted.counts,
      gate,
      ...(usage ? { usage } : {}),
      ...(usage && anyRateConfigured(modelRates(config))
        ? { cost: computeCost(usage, modelRates(config)) }
        : {}),
      ...(verdicts !== undefined
        ? {
            exclusionModel: {
              id: verdicts.id,
              usage: verdicts.usage,
              ...(anyRateConfigured(verdicts.rates)
                ? { cost: computeCost(verdicts.usage, verdicts.rates) }
                : {}),
            },
          }
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
      ...(facts !== undefined ? { factsOnly: facts } : {}),
      ...(prepass !== undefined ? { semgrep: semgrepTally(prepass) } : {}),
      ...(blocked !== undefined ? { budget: blocked } : {}),
      ...(blocked === undefined && ceiling.reached()
        ? {
            budget: {
              stopped: true as const,
              spent: ceiling.spent(),
              limit: ceiling.limit,
              reasons: [ceilingReason(ceiling)],
            },
          }
        : {}),
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
    if (config.output.findingsDir !== undefined) {
      const evidence = writeReviewRecord(
        deps.cwd,
        {
          staged: options.staged === true,
          target: acquired.targetRef,
          ...(acquired.mode === "incremental" ? { since: config.review.lastReviewedCommit } : {}),
        },
        deps.clock?.() ?? new Date(),
        {
          fingerprints: fingerprintsOf(report.findings),
          redact: (text) =>
            redactDiff(text, compileCustomPatterns(config.redaction.patterns), {
              strict: config.redaction.strict,
            }).text,
        },
      );
      writeFindingsFile(deps.cwd, config.output.findingsDir, report.findings, evidence);
    }
  }

  await publishIfConfigured(
    deps,
    config,
    {
      findings: kept,
      proposals,
      droppedUncited: parsed.droppedUncited,
      droppedOffChange: onChange.dropped.length,
      filtered: filtered.length,
      ...(accepted.length > 0 ? { accepted: accepted.length } : {}),
      gate,
      changedFiles: changedFiles.length,
      scope: acquired.scope,
      commitStatus: config.scm.commitStatus,
      comments: config.scm.comments,
      dryRun: isDryRun(config),
      ...(facts !== undefined ? { factsOnly: factsScope(facts, config) } : {}),
      ...(unparsedFiles.length > 0
        ? {
            unreviewed: {
              files: unparsedFiles,
              ...(cappedFiles.length > 0 ? { capHit: cappedFiles } : {}),
              status: config.fallback.status,
            },
          }
        : {}),
    },
    sources,
  );

  if (usage !== undefined) {
    deps.err(`${await spendLine(config, usage, now, verdicts)}\n`);
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
        ...(factsOnly
          ? { model: "none", cost: 0 }
          : config.model.id !== undefined
            ? { model: config.model.id }
            : {}),
        ...(usage !== undefined ? { usage } : {}),
        ...(!factsOnly && usage !== undefined && anyRateConfigured(rates)
          ? { cost: computeCost(usage, rates).total + verdictCost(verdicts) }
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
/** The exclusion verdicts' spend when `exclusions.model` runs them on a model of their own. */
export interface VerdictSpend {
  id: string;
  usage: ModelUsage;
  rates: CostRates;
}

const verdictCost = (verdicts: VerdictSpend | undefined): number =>
  verdicts === undefined ? 0 : computeCost(verdicts.usage, verdicts.rates).total;

export async function spendLine(
  config: Config,
  usage: ModelUsage,
  now: Date,
  verdicts?: VerdictSpend,
): Promise<string> {
  if (noModel(config)) return "cost: 0 tokens in, 0 out on none, 0.0000 USD; no model call";
  // the model id shows which rates priced the run, an env override included
  const tokens = [
    `${String(usage.inputTokens)} tokens in, ${String(usage.outputTokens)} out on ${config.model.id ?? "(unset model)"}`,
    ...(verdicts !== undefined
      ? [
          `verdicts ${String(verdicts.usage.inputTokens)} tokens in, ${String(verdicts.usage.outputTokens)} out on ${verdicts.id}`,
        ]
      : []),
  ].join(", ");
  const rates = modelRates(config);
  if (!anyRateConfigured(rates)) return `usage: ${tokens}; no cost rates configured`;
  const spent = computeCost(usage, rates).total + verdictCost(verdicts);
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
  /** The files of the batch, named when no model could review them. */
  files: string[];
  /** review.maxOutputTokens: no call of this pass, its retry included, asks for more. */
  outputCeiling: number;
  /** The batch cut in two, asked once when its reply cannot be read; empty when it cannot be cut. */
  slices?: () => Promise<PlannedPass[]>;
}

export type PromptOf = (diffText: string, context: string) => ModelRequest;

/** The context of a slice of the diff. */
export type ContextOf = (diffText: string) => Promise<string>;

/**
 * Every call a review makes, in order. Each batch carries its own context and
 * the same tools, so no batch is where a strategy silently stops running.
 * With contextOf, each batch can be cut into slices that carry their own context.
 */
export function planPasses(
  config: Config,
  diffBatches: readonly string[],
  batchContexts: readonly string[],
  contextTools: ToolSet | undefined,
  promptOf: PromptOf,
  contextOf?: ContextOf,
): PlannedPass[] {
  const pass = (diffText: string, context: string, label: string): PlannedPass => {
    const files = changedFilesFromDiff(diffText);
    return {
      label,
      request: {
        ...attachContextTools(
          promptOf(diffText, context),
          contextTools,
          config.context.maxToolRounds,
        ),
        maxOutputTokens: outputCapFor(files.length, config.review.maxOutputTokens),
      },
      files,
      outputCeiling: config.review.maxOutputTokens,
    };
  };
  return diffBatches.map((batchDiff, index) => {
    const label = `batch ${String(index + 1)}/${String(diffBatches.length)}`;
    const context = batchContexts[index] ?? "";
    const planned = pass(batchDiff, context, label);
    if (contextOf === undefined) return planned;
    const slices = async (): Promise<PlannedPass[]> => {
      const halves = halveDiff(batchDiff);
      if (halves.length < 2) return [];
      return Promise.all(
        halves.map(async (half, part) =>
          pass(
            half,
            context === "" ? "" : await contextOf(half),
            `${label}, slice ${String(part + 1)}/${String(halves.length)}`,
          ),
        ),
      );
    };
    return { ...planned, slices };
  });
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
  modelDiff: string,
  guidelines: readonly Guideline[],
  declared: DeclaredTags | undefined,
): Promise<AssembledReview> {
  const redact = (text: string): RedactedDiff =>
    redactDiff(text, compileCustomPatterns(config.redaction.patterns), {
      strict: config.redaction.strict,
    });
  const redacted = redact(diff);
  const redactionTotal = Object.values(redacted.counts).reduce((sum, n) => sum + n, 0);
  if (redactionTotal > 0) {
    deps.err(`${String(redactionTotal)} secret-shaped value(s) redacted before the model call\n`);
  }
  // the model reads only the hunks the rules left; everything else reads the whole diff
  const toModel = modelDiff === diff ? redacted.text : redact(modelDiff).text;

  const contextInput = {
    cwd: deps.cwd,
    diff: toModel,
    changedFiles: changedFilesFromDiff(toModel),
  };
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
  // the reply and a margin need room in the window too
  const budgetTokens = promptBudget(config.review.windowTokens, config.review.maxOutputTokens);
  const plan = planBudget({
    prefix,
    context: projectContext,
    diff: toModel,
    budgetTokens,
  });
  for (const notice of plan.notices) deps.err(`${notice}\n`);
  // splitting (when needed) happens regardless of contextTools: agentic tools
  // do not shrink the diff itself, so a batch too big to afford context whole
  // is still too big to afford context with tools bolted on. Packing reserves
  // room for prefix + context in every batch, so each batch gets its own
  // context decision instead of one drop-for-everyone verdict, and splitting
  // the diff is not, by itself, a reason to call the review degraded.
  const batches = planBatches(plan, toModel, projectContext, prefix, budgetTokens, {
    maxFiles: config.review.maxFilesPerBatch,
    maxTokens: config.review.maxTokensPerBatch,
  });
  for (const notice of batches.notices) deps.err(`${notice}\n`);
  const { diffBatches, degraded: budgetDegraded } = batches;
  const contextOf: ContextOf = (diffText) =>
    resolvedContext.scoped({
      cwd: deps.cwd,
      diff: diffText,
      changedFiles: changedFilesFromDiff(diffText),
    });
  // each batch carries the context of its own files, never the whole change's again
  const batchContexts =
    diffBatches.length < 2
      ? batches.batchContexts
      : await Promise.all(
          diffBatches.map((batchDiff, index) =>
            batches.batchContexts[index] === "" ? Promise.resolve("") : contextOf(batchDiff),
          ),
        );

  const request = attachContextTools(
    promptOf(diffBatches[0] ?? toModel, batchContexts[0] ?? ""),
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
    passes: planPasses(config, diffBatches, batchContexts, contextTools, promptOf, contextOf),
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
  /** Set when some batches answered and the model could not run for the others. */
  outage?: ModelOutage;
  /** The files of the batches the model could not run for. */
  unjudgedFiles?: string[];
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
  modelPort: () => ModelPort,
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

  if (batchCount > 1) {
    deps.err(`budget: reviewing the diff in ${String(batchCount)} batch(es)\n`);
  }
  return {
    ...(await runPasses(deps, modelPort(), passes, parseOptions)),
    ensembleMembers: undefined,
  };
}

/** A facts only run's assembly: the diff redacted, no context, no prompt, nothing to price. */
function assembleFacts(
  deps: ReviewDeps,
  config: Config,
  diff: string,
  guidelines: readonly Guideline[],
): AssembledReview {
  const redacted = redactDiff(diff, compileCustomPatterns(config.redaction.patterns), {
    strict: config.redaction.strict,
  });
  const redactionTotal = Object.values(redacted.counts).reduce((sum, n) => sum + n, 0);
  if (redactionTotal > 0) {
    deps.err(`${String(redactionTotal)} secret-shaped value(s) redacted\n`);
  }
  return {
    redacted,
    request: { system: "", user: "" },
    passes: [],
    batchCount: 0,
    parseOptions: {
      guidelinesById: new Map(guidelines.map((guideline) => [guideline.id, guideline])),
      generalPass: false,
      observationSeverityCap: config.review.observationSeverityCap,
    },
    budgetDegraded: false,
    linters: [],
  };
}

/** The pre pass in the log: its notices, then what it found and withheld, or why it failed. */
function logPrepass(deps: ReviewDeps, prepass: PrepassOutcome): void {
  for (const notice of prepass.notices) deps.err(`${notice}\n`);
  if (prepass.failure !== undefined) {
    deps.err(
      `warning: semgrep pre pass failed (${prepass.failure}); the model reviews the whole diff, the rule guidelines included\n`,
    );
    return;
  }
  deps.err(
    `semgrep pre pass: ${String(prepass.findings.length)} finding(s), ${String(prepass.withheld.length)} hunk(s) withheld from the model\n`,
  );
}

/** The report's view of the pre pass. */
function semgrepTally(prepass: PrepassOutcome): SemgrepTally {
  return {
    ...(prepass.engine !== undefined ? { engine: prepass.engine } : {}),
    ruleSets: prepass.ruleSets,
    findings: prepass.findings.length,
    withheldHunks: prepass.withheld.length,
    ...(prepass.failure !== undefined ? { failure: prepass.failure } : {}),
  };
}

/** The one log line a review prints when its model could not run. */
function logFallback(deps: ReviewDeps, outage: ModelOutage): void {
  if (outage.why === "cost-cap") {
    deps.err(`cost cap: ${outage.detail}; no further model call, the rest checks facts only\n`);
    return;
  }
  deps.err(
    `model unavailable (${fallbackReason(outage.why)}): ${String(outage.detail.split("\n")[0])}; falling back to facts only\n`,
  );
}

/** The summary's view of a facts only run. */
function factsScope(facts: FactsOnly, config: Config): FactsScope {
  return {
    left: facts.leftToPerson.length,
    notReviewed: facts.notReviewed,
    ...(facts.fallback !== undefined
      ? { fallback: facts.fallback, fallbackStatus: config.fallback.status }
      : {}),
    ...(facts.modelReviewed !== undefined ? { modelReviewed: facts.modelReviewed } : {}),
    ...(facts.unjudgedFiles !== undefined ? { unjudgedFiles: facts.unjudgedFiles } : {}),
  };
}

/** The review's model behind the response cache; the open passes and the judge share it. Every caller runs only when the config names a model. */
function reviewPort(deps: ReviewDeps, config: Config): ModelPort {
  return withResponseCache(
    deps.modelPort ?? buildModelPort(config, deps.credentials, retryOf(deps)),
    config,
    deps.cwd,
    () => deps.clock?.() ?? new Date(),
    (notice) => {
      deps.err(`${notice}\n`);
    },
  );
}

/** Passes in flight at once; a focused review fans out one call per guideline, and four stays fast without tripping the provider rate limits that retries would then pay for. */
const PASS_CONCURRENCY = 4;

type Answer =
  | { ok: true; parsed: ParsedReview; reply: ModelReply }
  | {
      ok: false;
      reason: string;
      outage?: ModelOutage;
      /** What the calls that produced no answer cost. */
      spent?: ModelUsage;
    };

/** One answer and where it came from: the batch and the files it covered. */
type PassOutcome = Answer & {
  batch: number;
  files: string[];
  /** What earlier calls of the same pass cost, when this answer is a slice's. */
  carried?: ModelUsage;
};

const sumUsage = (a: ModelUsage | undefined, b: ModelUsage | undefined): ModelUsage | undefined =>
  a === undefined ? b : b === undefined ? a : addUsage(a, b);

/** Every call of an outcome was paid for, the ones that gave no answer included. */
const usageOfOutcome = (outcome: PassOutcome): ModelUsage | undefined =>
  sumUsage(outcome.ok ? outcome.reply.usage : outcome.spent, outcome.carried);

/** The parse of a reply; one that stopped on the output cap with no text is named for that. */
function readReply(reply: ModelReply, parseOptions: ParseOptions): ParsedReview {
  if (hitOutputCap(reply)) throw new Error(OUTPUT_CAP_HIT);
  return parseReviewResponse(reply.text, parseOptions);
}

/**
 * One call and its parse. askAgain adds one more answering step when the
 * reply holds no JSON; an outage on either step is an outage, not a bad reply.
 */
async function answerPass(
  deps: Pick<ReviewDeps, "err">,
  modelPort: ModelPort,
  pass: PlannedPass,
  parseOptions: ParseOptions,
  askAgain: boolean,
): Promise<Answer> {
  let reply: ModelReply;
  try {
    reply = await completeOrFail(modelPort, pass.request);
  } catch (error) {
    if (!(error instanceof ModelUnavailableError)) throw error;
    return { ok: false, reason: error.message, outage: { why: error.why, detail: error.message } };
  }
  // what the replies read so far cost, kept for when none of them answers
  let spent = reply.usage;
  try {
    try {
      return { ok: true, parsed: readReply(reply, parseOptions), reply };
    } catch (error) {
      if (!askAgain) throw error;
      // one more answering step, tools off, with what the model fetched replayed as text
      deps.err(
        `${pass.label}: ${(error as Error).message}; asking once more for the JSON answer\n`,
      );
      const first = reply;
      reply = await completeOrFail(
        modelPort,
        retryRequest(pass.request, first, pass.outputCeiling),
      );
      spent = sumUsage(first.usage, reply.usage);
      reply = {
        ...reply,
        ...(spent !== undefined ? { usage: spent } : {}),
        ...(first.toolCalls !== undefined ? { toolCalls: first.toolCalls } : {}),
      };
      return { ok: true, parsed: readReply(reply, parseOptions), reply };
    }
  } catch (error) {
    const reason = (error as Error).message;
    const paid = spent !== undefined ? { spent } : {};
    // an outage on the second answering step is an outage, not an unreadable reply
    if (error instanceof ModelUnavailableError) {
      return { ok: false, reason, outage: { why: error.why, detail: reason }, ...paid };
    }
    return { ok: false, reason, ...paid };
  }
}

/**
 * One planned pass to its outcomes. A reply with no readable JSON is asked
 * once more, then the batch is asked once as two smaller slices; whatever
 * still cannot be read costs only its own files.
 */
async function runPass(
  deps: Pick<ReviewDeps, "err">,
  modelPort: ModelPort,
  pass: PlannedPass,
  batch: number,
  parseOptions: ParseOptions,
): Promise<PassOutcome[]> {
  const answer = await answerPass(deps, modelPort, pass, parseOptions, true);
  if (answer.ok || answer.outage !== undefined) return [{ ...answer, batch, files: pass.files }];
  const slices = (await pass.slices?.()) ?? [];
  if (slices.length === 0) {
    deps.err(`${pass.label}: ${answer.reason}; skipping this batch's findings\n`);
    return [{ ...answer, batch, files: pass.files }];
  }
  deps.err(`${pass.label}: retrying with a smaller slice\n`);
  const outcomes: PassOutcome[] = [];
  const spentBefore = answer.spent;
  for (const slice of slices) {
    const sliced = await answerPass(deps, modelPort, slice, parseOptions, false);
    if (!sliced.ok && sliced.outage === undefined) {
      deps.err(`${slice.label}: ${sliced.reason}; skipping this slice's findings\n`);
    }
    // the whole batch's failed calls are paid once, by its first slice
    const carried = outcomes.length === 0 ? spentBefore : undefined;
    outcomes.push({
      ...sliced,
      batch,
      files: slice.files,
      ...(carried !== undefined ? { carried } : {}),
    });
  }
  return outcomes;
}

/**
 * Runs every planned pass and folds the replies into one parsed result. A
 * reply that cannot be read costs only its own files' findings: the others
 * were paid for and stand beside it, and the files are named as not reviewed.
 */
export async function runPasses(
  deps: Pick<ReviewDeps, "err">,
  modelPort: ModelPort,
  passes: readonly PlannedPass[],
  parseOptions: ParseOptions,
): Promise<Omit<ExecuteResult, "ensembleMembers">> {
  const outcomes = (
    await inPool(
      passes.map((pass, index) => () => runPass(deps, modelPort, pass, index + 1, parseOptions)),
      PASS_CONCURRENCY,
    )
  ).flat();
  const outages = outcomes.flatMap((outcome) =>
    !outcome.ok && outcome.outage !== undefined ? [{ outage: outcome.outage, outcome }] : [],
  );
  const firstOutage = outages[0]?.outage;
  // no batch answered: the whole review falls back
  if (firstOutage !== undefined && !outcomes.some((outcome) => outcome.ok)) {
    throw new ModelUnavailableError(firstOutage.why, firstOutage.detail);
  }
  const merged: Finding[] = [];
  const usage: ModelUsage | undefined = outcomes.reduce<ModelUsage | undefined>(
    (sum, outcome) => sumUsage(sum, usageOfOutcome(outcome)),
    undefined,
  );
  let toolCalls: number | undefined;
  let cachedResponse = false;
  const counts = { uncited: 0, outOfScope: 0, adjusted: 0, malformed: 0, misquoted: 0 };
  const rejected: RejectedCandidate[] = [];
  const unparsedBatches: UnparsedBatch[] = [];
  for (const outcome of outcomes) {
    if (!outcome.ok && outcome.outage !== undefined) continue;
    if (!outcome.ok) {
      unparsedBatches.push({
        batch: outcome.batch,
        of: passes.length,
        reason: outcome.reason,
        files: outcome.files,
      });
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
    if (reply.toolCalls !== undefined && reply.toolCalls > 0) {
      toolCalls = (toolCalls ?? 0) + reply.toolCalls;
    }
    if (reply.cached === true) cachedResponse = true;
  }
  if (toolCalls !== undefined) {
    deps.err(`agentic context: ${String(toolCalls)} tool call(s) served\n`);
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
    ...(firstOutage !== undefined
      ? {
          outage: firstOutage,
          unjudgedFiles: outages.flatMap(({ outcome }) => outcome.files),
        }
      : {}),
  };
}

async function completeOrFail(port: ModelPort, request: ModelRequest): Promise<ModelReply> {
  try {
    return await port.complete(request);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    const message = `model call failed: ${(error as Error).message}`;
    // the review applies fallback.credentialRefused
    const why = unavailability(error, "fallback");
    throw why !== undefined ? new ModelUnavailableError(why, message) : new ToolError(message);
  }
}

/**
 * The retry of an answering step whose reply held no JSON: the same prompt,
 * the tool results the model had fetched as text, its own reply, and one
 * instruction to answer in the requested shape. No tools, so it must answer.
 * A reply that ran out of output gets twice its cap, never more than ceiling.
 */
export function retryRequest(
  request: ModelRequest,
  reply: ModelReply,
  ceiling: number,
): ModelRequest {
  const capped = hitOutputCap(reply);
  const cap = request.maxOutputTokens;
  const answerNow =
    'Reply now with the JSON object only, in the shape requested above; if nothing violates a guideline reply {"findings": []}.';
  return {
    system: request.system,
    user: [
      withFetched(request.user, reply.transcript),
      "",
      ...(capped
        ? [`Your previous reply ran out of output before any answer. Reason briefly. ${answerNow}`]
        : [
            "Your previous reply:",
            "<reply>",
            reply.text,
            "</reply>",
            "",
            `That reply held no JSON answer. ${answerNow}`,
          ]),
    ].join("\n"),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    // a reply that ran out of output is asked again with twice the room, never above the ceiling
    ...(capped
      ? {
          maxOutputTokens: Math.min(
            ceiling,
            (cap ?? DEFAULT_MAX_OUTPUT_TOKENS) * OUTPUT_CAP_RETRY_FACTOR,
          ),
        }
      : cap !== undefined
        ? { maxOutputTokens: cap }
        : {}),
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
  capReached: boolean,
): Promise<FinalizedFindings> {
  const partitioned = partitionFindings(findings, config);
  const filtered = partitioned.filtered;
  let kept = partitioned.kept;
  let usage = usageIn;
  if (config.calibration.enabled && capReached) {
    deps.err("calibration skipped: the review reached its cost cap\n");
  }
  if (config.calibration.enabled && !capReached) {
    const ref = config.calibration.model;
    const calibrationPort = ref
      ? (deps.modelPortFor?.(ref) ??
        buildModelPortFor(ref, deps.credentials, config.model.timeoutSeconds, retryOf(deps)))
      : (deps.modelPort ?? buildModelPort(config, deps.credentials, retryOf(deps)));
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
  const scope = scopeOfFiles(
    changedFilesFromDiff(raw),
    config.review.include,
    config.review.exclude,
  );
  const notices = [
    `local git diff unavailable (${String(causeMessage)}); using the SCM API diff instead`,
    "incremental review and target fetching degrade in API-diff mode",
  ];
  if (Buffer.byteLength(text, "utf8") > config.review.maxDiffBytes) {
    notices.push("diff exceeds the configured size ceiling");
    return { text: "", mode: "full", targetRef: "scm api", notices, skipped: "too-large", scope };
  }
  return { text, mode: "full", targetRef: "scm api", notices, scope };
}

/**
 * A run with nothing to review still reconciles: stale comments from earlier
 * runs resolve, the summary refreshes, and the status turns green.
 */
async function publishAllClear(
  deps: ReviewDeps,
  config: Config,
  line: string,
  sources: PublishSources,
  scope?: ChangeScope,
): Promise<void> {
  await publishIfConfigured(
    deps,
    config,
    {
      findings: [],
      proposals: [],
      droppedUncited: 0,
      filtered: 0,
      gate: evaluateGate([], config.gate.failOn),
      outcome: { kind: "not-reviewed", line },
      ...(scope !== undefined ? { scope } : {}),
      commitStatus: config.scm.commitStatus,
      comments: config.scm.comments,
      dryRun: isDryRun(config),
    },
    sources,
  );
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

/** The first line of a failure, readable on a pull request. */
function failureReason(error: ToolError): string {
  const first = String(error.message.split("\n")[0]);
  if (error instanceof ModelUnavailableError) {
    return `the model could not run (${unavailableReason(error.why)}): ${first}`;
  }
  if (/held no JSON|not valid JSON|failed to parse|expected shape/.test(error.message)) {
    return "the model's reply held no readable findings, twice";
  }
  return first;
}

/** The retry's backoff on the injected delay, when a test gives one. */
function retryOf(deps: ReviewDeps): RetryOptions {
  return { wait: deps.wait };
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

/** The checked out commit, full hash; undefined outside a git checkout. */
function reviewedCommit(cwd: string): string | undefined {
  try {
    return runGit(cwd, ["rev-parse", "HEAD"]).trim();
  } catch {
    return undefined;
  }
}

/** Where the published text's links come from: the loaded guidelines and the target ref. */
interface PublishSources {
  guidelines: Pick<ResolvedGuidelines, "guidelines" | "origin">;
  targetRef: string;
}

/** True when the ref holds the file. */
function fileOnRef(cwd: string, ref: string, file: string): boolean {
  try {
    runGit(cwd, ["cat-file", "-e", `${ref}:${file}`]);
    return true;
  } catch {
    return false;
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
  sources?: PublishSources,
): Promise<void> {
  if (config.scm.provider === "local") return;
  // publishReview itself holds the hard guarantee now: a dry run trips zero
  // adapter writes even if this caller got the plumbing wrong.
  const scm = deps.scmPort ?? buildScmPort(config, deps.credentials, deps.ciBuildUrl);
  const { guidePath } = config.review;
  const lines = new Map<string, readonly string[] | undefined>();
  const head = reviewedCommit(deps.cwd);
  // the guide links to the target branch, so only a guide already there gets a link
  const guideOnTarget =
    sources === undefined ? undefined : fileOnRef(deps.cwd, sources.targetRef, guidePath);
  const guideExists = guideOnTarget === true || existsSync(path.resolve(deps.cwd, guidePath));
  const outcome = await publishReview(scm, {
    ...input,
    ...(head !== undefined ? { reviewedCommit: head } : {}),
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
      ...(guideExists ? { guidePath } : {}),
      ...(guideOnTarget === false ? { guideLinked: false } : {}),
      ...(config.tickets.url !== undefined
        ? { tickets: { url: config.tickets.url, pattern: config.tickets.pattern } }
        : {}),
      ...(sources !== undefined
        ? { guidelineFiles: guidelineSources(deps.cwd, sources.guidelines, head) }
        : {}),
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
