import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/loader.js";
import { checkCostGuard, guardActive } from "../cost/guard.js";
import { defaultCounterPath, monthKey, recordSpend } from "../cost/counter.js";
import type { RuntimeDeps } from "../deps.js";
import type { Finding } from "../domain/finding.js";
import { evaluateGate } from "../domain/gate.js";
import { ToolError } from "../errors.js";
import { newLineTexts } from "../git/diff.js";
import { appliesTo } from "../guidelines/languages.js";
import { loadGuidelines } from "../guidelines/loader.js";
import { buildModelPort } from "../model/build.js";
import { addUsage, anyRateConfigured, computeCost } from "../model/usage.js";
import type { ModelUsage } from "../model/port.js";
import { renderCodeQuality, renderSarif } from "../review/artifacts.js";
import { loadBaseline, splitByBaseline, writeBaseline } from "../review/baseline.js";
import { fingerprintOf } from "../domain/finding.js";
import { buildPromptOptions, buildReviewPrompt } from "../review/prompt.js";
import { parseReviewResponse } from "../review/parse.js";
import { compileCustomPatterns, redactDiff } from "../review/redact.js";
import { renderReview } from "../review/render.js";
import { buildReport } from "../review/report.js";
import { batchFiles, collectFiles } from "../review/tree-scan.js";

export interface AuditOptions {
  writeBaseline?: boolean;
}

/** Reviews the whole tree against the guidelines; publishes nothing to any SCM. */
export async function runAudit(
  deps: RuntimeDeps,
  flags: Readonly<Record<string, string>>,
  options: AuditOptions = {},
): Promise<number> {
  const config = loadConfig({ root: deps.cwd, env: deps.env, flags });
  const loaded = loadGuidelines(
    path.join(deps.cwd, config.review.guidelinesDir),
    config.review.frontmatterContract,
  );
  for (const problem of loaded.problems) deps.err(`guideline skipped: ${problem}\n`);
  for (const notice of loaded.notices) deps.err(`${notice}\n`);
  if (loaded.guidelines.length === 0) {
    throw new ToolError("audit needs guidelines; none were usable");
  }

  const notices: string[] = [];
  const files = collectFiles(deps.cwd, config.review.include, config.review.exclude).filter(
    (file) =>
      !file.startsWith(`${config.review.guidelinesDir}/`) && file !== config.review.baselinePath,
  );
  const batches = batchFiles(deps.cwd, files, config.review.maxDiffBytes, notices).filter((batch) =>
    loaded.guidelines.some((guideline) => appliesTo(guideline, batch.files)),
  );
  for (const notice of notices) deps.err(`${notice}\n`);
  if (batches.length === 0) {
    deps.out("nothing to audit: no files match a guideline's scope\n");
    return 0;
  }
  deps.err(`auditing ${String(files.length)} file(s) in ${String(batches.length)} batch(es)\n`);

  const patterns = compileCustomPatterns(config.redaction.patterns);
  const promptOptions = buildPromptOptions(config, deps.cwd);
  const requests = batches.map((batch) => {
    const guidelines = loaded.guidelines.filter((guideline) => appliesTo(guideline, batch.files));
    const redacted = redactDiff(batch.diff, patterns, { strict: config.redaction.strict });
    return {
      guidelines,
      redacted,
      request: buildReviewPrompt(guidelines, redacted.text, promptOptions),
    };
  });

  const now = deps.clock?.() ?? new Date();
  if (guardActive(config)) {
    // one combined estimate: every batch's full prompt, one response stand-in
    const combined = {
      system: requests.map((entry) => entry.request.system).join("\n"),
      user: requests.map((entry) => entry.request.user).join("\n"),
    };
    const decision = await checkCostGuard(config, combined, now);
    for (const notice of decision.notices) deps.err(`${notice}\n`);
    if (!decision.allowed) {
      for (const reason of decision.reasons) deps.out(`budget: ${reason}\n`);
      deps.out("audit blocked by the cost guard before any model call\n");
      return 1;
    }
  }

  const modelPort = deps.modelPort ?? buildModelPort(config, deps.env);
  const seen = new Set<string>();
  const findings: Finding[] = [];
  let usage: ModelUsage | undefined;
  let droppedUncited = 0;
  let droppedOutOfScope = 0;
  let adjustedLines = 0;
  let droppedMalformed = 0;
  const redactionCounts: Record<string, number> = {};
  for (const entry of requests) {
    let reply;
    try {
      reply = await modelPort.complete(entry.request);
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError(`model call failed: ${(error as Error).message}`);
    }
    if (reply.usage) usage = usage ? addUsage(usage, reply.usage) : reply.usage;
    const parsed = parseReviewResponse(reply.text, {
      guidelinesById: new Map(entry.guidelines.map((guideline) => [guideline.id, guideline])),
      generalPass: config.review.generalPass,
      observationSeverityCap: config.review.observationSeverityCap,
    });
    droppedUncited += parsed.droppedUncited;
    droppedOutOfScope += parsed.droppedOutOfScope;
    adjustedLines += parsed.adjustedLines;
    droppedMalformed += parsed.droppedMalformed;
    for (const [name, count] of Object.entries(entry.redacted.counts)) {
      redactionCounts[name] = (redactionCounts[name] ?? 0) + count;
    }
    for (const finding of parsed.findings) {
      const fingerprint = fingerprintOf(finding);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      findings.push(finding);
    }
  }

  const floor = config.review.confidenceFloor;
  let kept = findings.filter((finding) => (finding.confidence ?? 1) >= floor);
  const filtered = findings.filter((finding) => (finding.confidence ?? 1) < floor);

  if (options.writeBaseline === true) {
    const accepted = writeBaseline(deps.cwd, config.review.baselinePath, kept);
    deps.out(
      `baseline written: ${String(accepted)} finding(s) accepted into ${config.review.baselinePath}\n`,
    );
  }
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

  const observations = kept.filter((finding) => finding.kind === "observation");
  const gate = evaluateGate(kept, config.gate.failOn);
  deps.out(
    renderReview({
      violations: kept.filter((finding) => finding.kind === "violation"),
      observations,
      proposals: [],
      droppedUncited,
      droppedOutOfScope,
      adjustedLines,
      droppedMalformed,
      filtered: filtered.length,
      gate,
    }),
  );

  const wantsArtifacts =
    config.output.report !== undefined ||
    config.output.sarifPath !== undefined ||
    config.output.codeQualityPath !== undefined;
  if (wantsArtifacts) {
    const anchorTexts = newLineTexts(requests.map((entry) => entry.redacted.text).join(""));
    const report = buildReport({
      lineTextOf: (finding) => anchorTexts.get(finding.file)?.get(finding.line),
      findings: kept,
      baselined,
      filtered,
      proposals: [],
      droppedUncited,
      droppedOutOfScope,
      adjustedLines,
      droppedMalformed,
      redactions: redactionCounts,
      gate,
      ...(usage ? { usage } : {}),
      ...(usage && anyRateConfigured(config.cost) ? { cost: computeCost(usage, config.cost) } : {}),
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

  if (usage && anyRateConfigured(config.cost)) {
    const spent = computeCost(usage, config.cost).total;
    await recordSpend(config.cost.counterPath ?? defaultCounterPath(), monthKey(now), spent);
  }

  return gate.failed ? 2 : 0;
}
