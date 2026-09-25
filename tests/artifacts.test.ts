import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderCodeQuality, renderSarif } from "../src/review/artifacts.js";
import { runCli } from "../src/index.js";
import type { ModelPort } from "../src/model/port.js";
import type { ReportedFinding } from "../src/review/report.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const GUIDELINES = [
  "---\nid: no-console\nseverity: BLOCKER\n---\n# No console\n\nUse the logger.\n",
  "---\nid: no-todo\nseverity: MAJOR\n---\n# No TODO\n\nFile an issue instead.\n",
  "---\nid: prefer-const\nseverity: MINOR\n---\n# Prefer const\n\nUse const.\n",
];

const REPLY = JSON.stringify({
  findings: [
    {
      guidelineId: "no-console",
      file: "src/app.js",
      line: 1,
      title: "Console",
      body: "b1",
      guidelineQuote: "Use the logger.",
    },
    {
      guidelineId: "no-todo",
      file: "src/app.js",
      line: 2,
      title: "Todo",
      body: "b2",
      guidelineQuote: "File an issue instead.",
    },
    {
      guidelineId: "prefer-const",
      file: "src/app.js",
      line: 3,
      title: "Let",
      body: "b3",
      guidelineQuote: "Prefer const",
    },
  ],
});

function reviewedRepo(): string {
  const repo = makeRepo();
  GUIDELINES.forEach((guideline, index) => {
    write(repo, `guidelines/g${String(index)}.md`, guideline);
  });
  commitAll(repo, "rules");
  git(repo, "checkout", "-q", "-b", "feature");
  write(repo, "src/app.js", "console.log('x');\n// TODO fix\nlet a = 1;\n");
  commitAll(repo, "change");
  return repo;
}

const model: ModelPort = { complete: () => Promise.resolve({ text: REPLY }) };

interface SarifLog {
  $schema: string;
  version: string;
  runs: {
    tool: { driver: { name: string; rules: { id: string }[] } };
    results: {
      ruleId: string;
      level: string;
      message: { text: string };
      locations: {
        physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } };
      }[];
      partialFingerprints: Record<string, string>;
    }[];
  }[];
}

describe("review artifacts", () => {
  it("writes valid SARIF and Code Quality artifacts alongside the report", async () => {
    const repo = reviewedRepo();
    const code = await runCli(["review"], {
      cwd: repo,
      env: {
        DELTA_PEACOCK_OUTPUT_SARIF_PATH: "findings.sarif",
        DELTA_PEACOCK_OUTPUT_CODE_QUALITY_PATH: "code-quality.json",
      },
      out: () => undefined,
      err: () => undefined,
      modelPort: model,
    });
    expect(code).toBe(0);

    const sarif = JSON.parse(readFileSync(path.join(repo, "findings.sarif"), "utf8")) as SarifLog;
    expect(sarif.$schema).toContain("sarif-2.1.0");
    expect(sarif.version).toBe("2.1.0");
    const run = sarif.runs[0];
    expect(run?.tool.driver.name).toBe("delta-peacock");
    expect(run?.tool.driver.rules.map((rule) => rule.id)).toEqual([
      "no-console",
      "no-todo",
      "prefer-const",
    ]);
    expect(run?.results.map((result) => result.level)).toEqual(["error", "warning", "note"]);
    const first = run?.results[0];
    expect(first?.locations[0]?.physicalLocation.artifactLocation.uri).toBe("src/app.js");
    expect(first?.locations[0]?.physicalLocation.region.startLine).toBe(1);
    expect(first?.partialFingerprints["deltaPeacockFingerprint"]).toMatch(/^[0-9a-f]{12}$/);

    const quality = JSON.parse(
      readFileSync(path.join(repo, "code-quality.json"), "utf8"),
    ) as Record<string, unknown>[];
    expect(quality).toHaveLength(3);
    expect(quality.map((entry) => entry["severity"])).toEqual(["blocker", "major", "minor"]);
    expect(quality[0]).toMatchObject({
      check_name: "no-console",
      location: { path: "src/app.js", lines: { begin: 1 } },
    });
    expect(quality[0]?.["fingerprint"]).toMatch(/^[0-9a-f]{12}$/);
  });

  it("writes artifacts even without a JSON report configured", async () => {
    const repo = reviewedRepo();
    const code = await runCli(["review"], {
      cwd: repo,
      env: { DELTA_PEACOCK_OUTPUT_SARIF_PATH: "findings.sarif" },
      out: () => undefined,
      err: () => undefined,
      modelPort: model,
    });
    expect(code).toBe(0);
    const sarif = JSON.parse(readFileSync(path.join(repo, "findings.sarif"), "utf8")) as SarifLog;
    expect(sarif.runs[0]?.results).toHaveLength(3);
  });

  it("maps an observation to its own rule id in both formats", () => {
    const finding: ReportedFinding = {
      kind: "observation",
      severity: "INFO",
      file: "src/app.js",
      line: 9,
      title: "Thought",
      body: "b",
      fingerprint: "abcdef123456",
    };
    const sarif = JSON.parse(renderSarif([finding])) as SarifLog;
    expect(sarif.runs[0]?.results[0]?.ruleId).toBe("observation");
    expect(sarif.runs[0]?.results[0]?.level).toBe("note");
    const quality = JSON.parse(renderCodeQuality([finding])) as Record<string, unknown>[];
    expect(quality[0]?.["check_name"]).toBe("observation");
    expect(quality[0]?.["severity"]).toBe("info");
  });

  it("renders empty artifacts for a clean review", () => {
    const sarif = JSON.parse(renderSarif([])) as SarifLog;
    expect(sarif.runs[0]?.results).toEqual([]);
    expect(JSON.parse(renderCodeQuality([]))).toEqual([]);
  });
});
