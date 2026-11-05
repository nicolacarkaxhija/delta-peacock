import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import type { ModelPort, ModelRequest } from "../src/model/port.js";
import type { ReviewReport } from "../src/review/report.js";
import type { InsightReport, ScmPort } from "../src/scm/port.js";
import type { SemgrepRun, SemgrepRunner } from "../src/review/semgrep/run.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const SENTENCE = "A log call never chains on getLogger.";

const RULED = `---
id: logger-assigned-once
severity: MAJOR
languages: [javascript]
paths: ["cartridges/**"]
check:
  type: semgrep
  message: ${SENTENCE}
---
# Assign the logger once

${SENTENCE}
`;

const RULES = `rules:
  - id: chained-logger
    languages: [javascript]
    severity: WARNING
    message: ${SENTENCE}
    pattern: $X.getLogger(...).$LEVEL(...)
`;

const JUDGED = `---
id: no-console
severity: MINOR
paths: ["src/**"]
tags: [judged]
---
# No console

Use the logger instead of console.
`;

const GIFT_BASE = [
  "var Logger = require('dw/system/Logger');",
  "function a() {",
  "    return 1;",
  "}",
  "",
].join("\n");
const GIFT_HIT = [
  "var Logger = require('dw/system/Logger');",
  "function a() {",
  "    Logger.getLogger('gift', 'pack').error('boom');",
  "    return 1;",
  "}",
  "",
].join("\n");
const GIFT_CLEAN = [
  "var Logger = require('dw/system/Logger');",
  "function a() {",
  "    var two = 2;",
  "    return 1;",
  "}",
  "",
].join("\n");

/** main holds both guidelines; feature changes the cartridge script and, when asked, src/app.js. */
function scenario(gift: string, app = true): string {
  const repo = makeRepo();
  write(repo, "guidelines/logger-assigned-once.md", RULED);
  write(repo, "guidelines/logger-assigned-once.semgrep.yaml", RULES);
  write(repo, "guidelines/no-console.md", JUDGED);
  write(repo, "cartridges/app_shop_core/cartridge/scripts/gift.js", GIFT_BASE);
  commitAll(repo, "base");
  git(repo, "checkout", "-q", "-b", "feature");
  write(repo, "cartridges/app_shop_core/cartridge/scripts/gift.js", gift);
  if (app)
    write(repo, "src/app.js", "function greet(name) {\n  console.log(name);\n  return name;\n}\n");
  commitAll(repo, "change");
  return repo;
}

const HIT: SemgrepRun = {
  ok: true,
  version: "1.183.0",
  hits: [
    {
      ruleId: "logger-assigned-once.chained-logger",
      path: "cartridges/app_shop_core/cartridge/scripts/gift.js",
      startLine: 3,
      endLine: 3,
    },
  ],
  warnings: [],
};

const CLEAN: SemgrepRun = { ok: true, version: "1.183.0", hits: [], warnings: [] };

function recordingRunner(run: SemgrepRun): { runner: SemgrepRunner; calls: number } {
  const state = {
    calls: 0,
    runner: ((): Promise<SemgrepRun> => {
      state.calls += 1;
      return Promise.resolve(run);
    }) as SemgrepRunner,
  };
  return state;
}

function recordingModel(): { port: ModelPort; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    port: {
      complete(request) {
        requests.push(request);
        return Promise.resolve({
          text: '{"findings": []}',
          usage: { inputTokens: 10, outputTokens: 2 },
        });
      },
    },
  };
}

interface Reviewed {
  code: number;
  stderr: string;
  requests: ModelRequest[];
  report: ReviewReport;
  semgrepCalls: number;
}

/** A pull request host that keeps the Code Insights reports it is handed. */
function insightsHost(): { scm: ScmPort; reports: InsightReport[] } {
  const reports: InsightReport[] = [];
  return {
    reports,
    scm: {
      listInlineComments: () => Promise.resolve([]),
      createInlineComment: () => Promise.resolve(),
      updateComment: () => Promise.resolve(),
      deleteComment: () => Promise.resolve(),
      listSummaryComments: () => Promise.resolve([]),
      createSummaryComment: () => Promise.resolve(),
      updateSummaryComment: () => Promise.resolve(),
      postStatus: () => Promise.resolve(),
      publishInsights: (report) => {
        reports.push(report);
        return Promise.resolve();
      },
    },
  };
}

async function review(
  repo: string,
  run: SemgrepRun,
  env: Record<string, string> = {},
  scmPort?: ScmPort,
): Promise<Reviewed> {
  const model = recordingModel();
  const semgrep = recordingRunner(run);
  let stderr = "";
  const code = await runCli(["review", "--report", "report.json"], {
    cwd: repo,
    env,
    out: () => undefined,
    err: (text) => {
      stderr += text;
    },
    modelPort: model.port,
    semgrepRunner: semgrep.runner,
    ...(scmPort !== undefined ? { scmPort } : {}),
  });
  const report = JSON.parse(readFileSync(path.join(repo, "report.json"), "utf8")) as ReviewReport;
  return { code, stderr, requests: model.requests, report, semgrepCalls: semgrep.calls };
}

const diffOf = (request: ModelRequest | undefined): string =>
  /<diff>\n([\s\S]*)\n<\/diff>/.exec(request?.user ?? "")?.[1] ?? "";

describe("the semgrep pre pass in a review", () => {
  it("reports a rule hit from producer semgrep and keeps its hunk from the model", async () => {
    const reviewed = await review(scenario(GIFT_HIT), HIT);
    expect(reviewed.semgrepCalls).toBe(1);
    expect(reviewed.report.findings).toEqual([
      expect.objectContaining({
        producer: "semgrep",
        guidelineId: "logger-assigned-once",
        severity: "MAJOR",
        file: "cartridges/app_shop_core/cartridge/scripts/gift.js",
        line: 3,
        title: SENTENCE,
      }),
    ]);
    expect(reviewed.requests).toHaveLength(1);
    const sent = diffOf(reviewed.requests[0]);
    expect(sent).toContain("src/app.js");
    expect(sent).not.toContain("gift.js");
    expect(reviewed.requests[0]?.system).not.toContain("logger-assigned-once");
    expect(reviewed.requests[0]?.system).toContain("no-console");
    expect(reviewed.report.semgrep).toEqual({
      engine: "1.183.0",
      ruleSets: ["local"],
      findings: 1,
      withheldHunks: 1,
    });
    expect(reviewed.stderr).toContain(
      "semgrep pre pass: 1 finding(s), 1 hunk(s) withheld from the model",
    );
  });

  it("makes no model call when the rules settle every hunk", async () => {
    const reviewed = await review(scenario(GIFT_HIT, false), HIT);
    expect(reviewed.requests).toEqual([]);
    expect(
      reviewed.report.findings.map((finding) =>
        finding.kind === "violation" ? finding.producer : undefined,
      ),
    ).toEqual(["semgrep"]);
    expect(reviewed.stderr).toContain("no open review call");
  });

  it("hands a clean diff to the model as it is", async () => {
    const on = await review(scenario(GIFT_CLEAN), CLEAN);
    const off = await review(scenario(GIFT_CLEAN), CLEAN, {
      DELTA_PEACOCK_SEMGREP_ENABLED: "false",
    });
    expect(on.report.findings).toEqual([]);
    expect(diffOf(on.requests[0])).toContain("gift.js");
    expect(diffOf(on.requests[0])).toBe(diffOf(off.requests[0]));
    expect(on.report.semgrep).toEqual({
      engine: "1.183.0",
      ruleSets: ["local"],
      findings: 0,
      withheldHunks: 0,
    });
  });

  it("restores the review without the pre pass when it is switched off", async () => {
    const reviewed = await review(scenario(GIFT_HIT), HIT, {
      DELTA_PEACOCK_SEMGREP_ENABLED: "false",
    });
    expect(reviewed.semgrepCalls).toBe(0);
    expect(diffOf(reviewed.requests[0])).toContain("getLogger('gift', 'pack').error('boom')");
    expect(reviewed.requests[0]?.system).toContain("logger-assigned-once");
    expect(reviewed.report.findings).toEqual([]);
    expect(reviewed.report.semgrep).toBeUndefined();
  });

  it("sends with the pre pass off the request origin/main sends for the same change", async () => {
    // recorded on origin/main, where the guideline carries no check block
    const recorded = readFileSync(
      new URL("fixtures/semgrep-off-request.json", import.meta.url),
      "utf8",
    );
    const reviewed = await review(scenario(GIFT_HIT), HIT, {
      DELTA_PEACOCK_SEMGREP_ENABLED: "false",
    });
    expect(JSON.stringify(reviewed.requests)).toBe(JSON.stringify(JSON.parse(recorded)));
  });

  it("warns and hands the model the whole diff when semgrep fails", async () => {
    const reviewed = await review(scenario(GIFT_HIT), {
      ok: false,
      reason: "semgrep timed out after 60s",
    });
    expect(reviewed.stderr).toContain(
      "warning: semgrep pre pass failed (semgrep timed out after 60s); the model reviews the whole diff, the rule guidelines included",
    );
    expect(diffOf(reviewed.requests[0])).toContain("getLogger('gift', 'pack').error('boom')");
    expect(reviewed.requests[0]?.system).toContain("logger-assigned-once");
    expect(reviewed.report.semgrep).toEqual({
      ruleSets: ["local"],
      findings: 0,
      withheldHunks: 0,
      failure: "semgrep timed out after 60s",
    });
  });

  it("checks the rules with no model at all", async () => {
    const reviewed = await review(scenario(GIFT_HIT), HIT, {
      DELTA_PEACOCK_MODEL_PROVIDER: "none",
    });
    expect(reviewed.requests).toEqual([]);
    expect(
      reviewed.report.findings.map((finding) =>
        finding.kind === "violation" ? finding.producer : undefined,
      ),
    ).toEqual(["semgrep"]);
    expect(reviewed.report.factsOnly?.notReviewed).toEqual(["no-console"]);
  });

  it("posts the rule finding in the Code Insights report and writes its producer to the findings file", async () => {
    const repo = scenario(GIFT_HIT);
    const host = insightsHost();
    const reviewed = await review(
      repo,
      HIT,
      {
        DELTA_PEACOCK_SCM_PROVIDER: "bitbucket",
        DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
        DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
        DELTA_PEACOCK_OUTPUT_FINDINGS_DIR: "findings",
      },
      host.scm,
    );
    expect(reviewed.code).toBe(0);
    expect(host.reports).toHaveLength(1);
    expect(host.reports[0]?.annotations).toEqual([
      expect.objectContaining({
        title: SENTENCE,
        path: "cartridges/app_shop_core/cartridge/scripts/gift.js",
        line: 3,
        severity: "MAJOR",
      }),
    ]);
    const written = JSON.parse(
      readFileSync(path.join(repo, "findings", "reviewer.json"), "utf8"),
    ) as { findings: { producer: string; rule: string }[] };
    expect(written.findings.map((finding) => [finding.producer, finding.rule])).toEqual([
      ["semgrep", "logger-assigned-once"],
    ]);
  });
});
