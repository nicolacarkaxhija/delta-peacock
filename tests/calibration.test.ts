import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/loader.js";
import { modelCallCount } from "../src/cost/guard.js";
import { runCli } from "../src/index.js";
import type { ModelPort, ModelRequest } from "../src/model/port.js";
import type { ReviewReport } from "../src/review/report.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const GUIDELINE = "---\nid: no-console\nseverity: MAJOR\n---\n# No console\n\nUse the logger.\n";

const TWO_FINDINGS = JSON.stringify({
  findings: [
    { guidelineId: "no-console", file: "src/app.js", line: 1, title: "First", body: "b" },
    { guidelineId: "no-console", file: "src/app.js", line: 2, title: "Second", body: "b" },
  ],
});

function repoWithChange(): string {
  const repo = makeRepo();
  write(repo, "guidelines/no-console.md", GUIDELINE);
  commitAll(repo, "rules");
  git(repo, "checkout", "-q", "-b", "feature");
  write(repo, "src/app.js", "console.log('one');\nconsole.log('two');\n");
  commitAll(repo, "change");
  return repo;
}

function isCalibration(request: ModelRequest): boolean {
  return request.user.includes("Findings under calibration");
}

/** Extracts the fingerprints the pipeline sent, so decisions can cite them. */
function sentFingerprints(request: ModelRequest): string[] {
  const start = request.user.indexOf("[");
  const end = request.user.lastIndexOf("]");
  const listed = JSON.parse(request.user.slice(start, end + 1)) as { fingerprint: string }[];
  return listed.map((entry) => entry.fingerprint);
}

/** One port serves both calls; the calibration reply is programmable. */
function duoPort(decide: (fingerprints: string[]) => string): {
  requests: ModelRequest[];
  port: ModelPort;
} {
  const requests: ModelRequest[] = [];
  return {
    requests,
    port: {
      complete(request) {
        requests.push(request);
        if (isCalibration(request)) {
          return Promise.resolve({
            text: decide(sentFingerprints(request)),
            usage: { inputTokens: 5, outputTokens: 5 },
          });
        }
        return Promise.resolve({
          text: TWO_FINDINGS,
          usage: { inputTokens: 100, outputTokens: 10 },
        });
      },
    },
  };
}

async function reviewWith(
  port: ModelPort,
  env: Record<string, string>,
  cwd = repoWithChange(),
): Promise<{ code: number; report: ReviewReport; stderr: string }> {
  const reportPath = path.join(cwd, "report.json");
  let stderr = "";
  const code = await runCli(["review", "--report", reportPath, "--fail-on", "MAJOR"], {
    cwd,
    env,
    out: () => undefined,
    err: (text) => {
      stderr += text;
    },
    modelPort: port,
  });
  return { code, report: JSON.parse(readFileSync(reportPath, "utf8")) as ReviewReport, stderr };
}

describe("calibration configuration", () => {
  it("stays off by default and counts one extra call when on", () => {
    const off = loadConfig({ root: makeRepo() });
    expect(off.calibration.enabled).toBe(false);
    expect(modelCallCount(off)).toBe(1);
    const on = loadConfig({
      root: makeRepo(),
      env: { DELTA_PEACOCK_CALIBRATION_ENABLED: "true" },
    });
    expect(modelCallCount(on)).toBe(2);
  });

  it("adds one on top of an ensemble too", () => {
    const config = loadConfig({
      root: makeRepo(),
      env: {
        DELTA_PEACOCK_CALIBRATION_ENABLED: "true",
        DELTA_PEACOCK_ENSEMBLE_ENABLED: "true",
        DELTA_PEACOCK_ENSEMBLE_MODE: "judge",
        DELTA_PEACOCK_ENSEMBLE_MEMBERS:
          '[{"provider":"anthropic","id":"a"},{"provider":"openrouter","id":"b"}]',
        DELTA_PEACOCK_ENSEMBLE_JUDGE: '{"provider":"anthropic","id":"a"}',
      },
    });
    expect(modelCallCount(config)).toBe(4); // two members, judge, calibration
  });
});

describe("calibration pass", () => {
  it("does not run when disabled", async () => {
    const { requests, port } = duoPort(() => "unused");
    const { code } = await reviewWith(port, {});
    expect(code).toBe(2); // two MAJOR violations gate the build
    expect(requests).toHaveLength(1);
  });

  it("drops with an audit trail and gates on what is left", async () => {
    const { requests, port } = duoPort((fingerprints) =>
      JSON.stringify({
        decisions: fingerprints.map((fingerprint) => ({
          fingerprint,
          action: "drop",
          reason: "false positive on a test fixture",
        })),
      }),
    );
    const { code, report } = await reviewWith(port, {
      DELTA_PEACOCK_CALIBRATION_ENABLED: "true",
    });
    expect(requests).toHaveLength(2);
    expect(code).toBe(0); // everything the gate would count was dropped
    expect(report.findings).toHaveLength(0);
    expect(report.calibration?.suppressed).toHaveLength(2);
    expect(report.calibration?.suppressed[0]?.reason).toContain("false positive");
    expect(report.calibration?.suppressed[0]?.action).toBe("drop");
  });

  it("demotes a violation into a visible observation that never gates", async () => {
    const { port } = duoPort((fingerprints) =>
      JSON.stringify({
        decisions: [{ fingerprint: fingerprints[0], action: "demote", reason: "minor nit" }],
      }),
    );
    const { code, report } = await reviewWith(port, {
      DELTA_PEACOCK_CALIBRATION_ENABLED: "true",
    });
    expect(code).toBe(2); // the second violation still gates
    expect(report.findings).toHaveLength(2);
    expect(report.findings.filter((finding) => finding.kind === "observation")).toHaveLength(1);
    expect(report.calibration?.suppressed[0]?.action).toBe("demote");
  });

  it("ignores unknown fingerprints and unusable decisions", async () => {
    const { port } = duoPort(() =>
      JSON.stringify({
        decisions: [
          { fingerprint: "not-a-real-fingerprint", action: "drop", reason: "aim missed" },
          { fingerprint: 42, action: "drop", reason: "bad shape" },
          { fingerprint: "also-missing", action: "explode", reason: "bad action" },
        ],
      }),
    );
    const { code, report } = await reviewWith(port, {
      DELTA_PEACOCK_CALIBRATION_ENABLED: "true",
    });
    expect(code).toBe(2);
    expect(report.findings).toHaveLength(2);
    expect(report.calibration?.suppressed).toHaveLength(0);
  });

  it("treats a decisions-less object and non-object entries as kept", async () => {
    const { port } = duoPort(() =>
      JSON.stringify({ decisions: ["a string", null, { action: "drop" }] }),
    );
    const { code, report } = await reviewWith(port, {
      DELTA_PEACOCK_CALIBRATION_ENABLED: "true",
    });
    expect(code).toBe(2);
    expect(report.findings).toHaveLength(2);
    expect(report.calibration?.suppressed).toHaveLength(0);
  });

  it("a reply whose json holds no decisions array is a fallback", async () => {
    const { port } = duoPort(() => JSON.stringify({ verdicts: [] }));
    const { report, stderr } = await reviewWith(port, {
      DELTA_PEACOCK_CALIBRATION_ENABLED: "true",
    });
    expect(report.findings).toHaveLength(2);
    expect(stderr).toContain("no decisions array");
  });

  it("a decision without a reason gets the placeholder", async () => {
    const { port } = duoPort((fingerprints) =>
      JSON.stringify({ decisions: [{ fingerprint: fingerprints[0], action: "drop" }] }),
    );
    const { report } = await reviewWith(port, { DELTA_PEACOCK_CALIBRATION_ENABLED: "true" });
    expect(report.calibration?.suppressed[0]?.reason).toBe("no reason given");
  });

  it("demoting an observation drops it outright", async () => {
    const withObservation: ModelPort = {
      complete(request) {
        if (isCalibration(request)) {
          const fingerprints = sentFingerprints(request);
          return Promise.resolve({
            text: JSON.stringify({
              decisions: fingerprints.map((fingerprint) => ({
                fingerprint,
                action: "demote",
                reason: "not worth a comment",
              })),
            }),
          });
        }
        return Promise.resolve({
          text: JSON.stringify({
            findings: [
              {
                file: "src/app.js",
                line: 1,
                title: "Style thought",
                body: "b",
                severity: "INFO",
              },
            ],
          }),
        });
      },
    };
    const repo = repoWithChange();
    const reportPath = path.join(repo, "report.json");
    const code = await runCli(["review", "--report", reportPath], {
      cwd: repo,
      env: {
        DELTA_PEACOCK_CALIBRATION_ENABLED: "true",
        DELTA_PEACOCK_REVIEW_GENERAL_PASS: "true",
      },
      out: () => undefined,
      err: () => undefined,
      modelPort: withObservation,
    });
    expect(code).toBe(0);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as ReviewReport;
    expect(report.findings).toHaveLength(0);
    expect(report.calibration?.suppressed[0]?.action).toBe("drop");
  });

  it("falls back to the uncalibrated set when the reply is unusable", async () => {
    const { port } = duoPort(() => "certainly! here are my thoughts, no json though");
    const { code, report, stderr } = await reviewWith(port, {
      DELTA_PEACOCK_CALIBRATION_ENABLED: "true",
    });
    expect(code).toBe(2); // the original gate outcome survives
    expect(report.findings).toHaveLength(2);
    expect(stderr).toContain("calibration failed");
  });

  it("sums calibration usage into the review's usage", async () => {
    const { port } = duoPort((fingerprints) =>
      JSON.stringify({
        decisions: [{ fingerprint: fingerprints[0], action: "keep", reason: "fine" }],
      }),
    );
    const { report } = await reviewWith(port, { DELTA_PEACOCK_CALIBRATION_ENABLED: "true" });
    expect(report.usage?.inputTokens).toBe(105);
    expect(report.usage?.outputTokens).toBe(15);
  });

  it("routes a dedicated calibration model through the member seam", async () => {
    const mainRequests: ModelRequest[] = [];
    const calibrationRequests: ModelRequest[] = [];
    const main: ModelPort = {
      complete(request) {
        mainRequests.push(request);
        return Promise.resolve({ text: TWO_FINDINGS });
      },
    };
    const cheap: ModelPort = {
      complete(request) {
        calibrationRequests.push(request);
        return Promise.resolve({ text: JSON.stringify({ decisions: [] }) });
      },
    };
    const repo = repoWithChange();
    const code = await runCli(["review"], {
      cwd: repo,
      env: {
        DELTA_PEACOCK_CALIBRATION_ENABLED: "true",
        DELTA_PEACOCK_CALIBRATION_MODEL: '{"provider":"anthropic","id":"cheap-model"}',
      },
      out: () => undefined,
      err: () => undefined,
      modelPort: main,
      modelPortFor: (ref) => {
        expect(ref.id).toBe("cheap-model");
        return cheap;
      },
    });
    expect(code).toBe(0);
    expect(mainRequests).toHaveLength(1);
    expect(calibrationRequests).toHaveLength(1);
    const firstCalibration = calibrationRequests[0];
    expect(firstCalibration !== undefined && isCalibration(firstCalibration)).toBe(true);
  });
});
