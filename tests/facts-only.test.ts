import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ANSWERS, planScaffold, withoutModelCredentials } from "../src/commands/init.js";
import { loadConfig } from "../src/config/loader.js";
import { runCli } from "../src/index.js";
import { buildModelPort } from "../src/model/build.js";
import type { ModelPort } from "../src/model/port.js";
import type { ReviewReport } from "../src/review/report.js";
import { spendLine } from "../src/review/run-review.js";
import { evaluateGate } from "../src/domain/gate.js";
import type { ScmPort } from "../src/scm/port.js";
import { publishReview } from "../src/scm/publish.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

// counts every model port the code builds; a facts only run must build none
const built = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/model/build.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/model/build.js")>();
  return {
    ...real,
    buildModelPort: (...args: Parameters<typeof real.buildModelPort>) => {
      built.count += 1;
      return real.buildModelPort(...args);
    },
    buildModelPortFor: (...args: Parameters<typeof real.buildModelPortFor>) => {
      built.count += 1;
      return real.buildModelPortFor(...args);
    },
  };
});

const PREFER = `---
id: prefer-test-ids
severity: MINOR
paths: ['pages/**']
---
# getByTestId first, then role and name, CSS last

Where a CSS selector is unavoidable, a comment next to it gives the reason.
`;

const NUMBERS = `---
id: no-magic-numbers
severity: MINOR
paths: ['src/**']
---
# No magic numbers

Every timeout, delay, retry count, limit or threshold is a named constant declared once, next to the reason it has that value, so one place answers why the code waits or stops where it does.
`;

const CONSOLE = `---
id: no-console
severity: MAJOR
---
# No console statements

Use the logger instead.
`;

const CONFIG = `model:
  provider: none
review:
  target: main
  fetchTarget: false
  checks:
    prefer-test-ids: selectors
    no-magic-numbers: numbers
gate:
  failOn: MAJOR
stats:
  enabled: true
cost:
  rateInputPer1M: 1
  rateOutputPer1M: 5
  maxPerReview: 0.000001
`;

const PAGE = [
  "export class ListPage {",
  "  tiles(): Locator {",
  "    return this.page.locator('.tile');",
  "  }",
  "  /** The listing's banner. */",
  "  banner(): Locator {",
  "    return this.page.locator('.banner');",
  "  }",
  "}",
  "",
].join("\n");

const APP = [
  "const RETRY_LIMIT = 3;",
  "// the rows on one page",
  "const PAGE_ROWS = 25;",
  "export function run(): number {",
  "  return RETRY_LIMIT + PAGE_ROWS;",
  "}",
  "",
].join("\n");

function scenario(config = CONFIG): string {
  const repo = makeRepo();
  write(repo, "guidelines/prefer-test-ids.md", PREFER);
  write(repo, "guidelines/no-magic-numbers.md", NUMBERS);
  write(repo, "guidelines/no-console.md", CONSOLE);
  write(repo, "delta-peacock.config.yaml", config);
  commitAll(repo, "guidelines");
  git(repo, "checkout", "-q", "-b", "feature");
  write(repo, "pages/list.ts", PAGE);
  write(repo, "src/app.ts", APP);
  commitAll(repo, "change");
  return repo;
}

/** A port that records a call and fails it, so any model call is loud. */
function forbidden(): { port: ModelPort; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    port: {
      complete() {
        calls.push(1);
        return Promise.reject(new Error("a facts only run called a model"));
      },
    },
  };
}

interface Posted {
  inline: string[];
  summary: string[];
  status: { state: string; description: string }[];
}

function recordingScm(): { scm: ScmPort; posted: Posted } {
  const posted: Posted = { inline: [], summary: [], status: [] };
  return {
    posted,
    scm: {
      listInlineComments: () => Promise.resolve([]),
      createInlineComment: (comment) => {
        posted.inline.push(comment.body);
        return Promise.resolve();
      },
      updateComment: () => Promise.resolve(),
      deleteComment: () => Promise.resolve(),
      listSummaryComments: () => Promise.resolve([]),
      createSummaryComment: (body) => {
        posted.summary.push(body);
        return Promise.resolve();
      },
      updateSummaryComment: () => Promise.resolve(),
      postStatus: (state, description) => {
        posted.status.push({ state, description });
        return Promise.resolve();
      },
    },
  };
}

async function run(
  repo: string,
  argv: string[],
  extra: { env?: Record<string, string>; scmPort?: ScmPort } = {},
): Promise<{ code: number; out: string; err: string; calls: number[] }> {
  let out = "";
  let err = "";
  const { port, calls } = forbidden();
  const code = await runCli(argv, {
    cwd: repo,
    env: extra.env ?? {},
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    modelPort: port,
    modelPortFor: () => port,
    ...(extra.scmPort !== undefined ? { scmPort: extra.scmPort } : {}),
  });
  return { code, out, err, calls };
}

const SELECTOR_QUESTION =
  "Does one of these comments say why a test id, or a role with a name, cannot address this element? A comment that only says what the element is or does gives no reason.";

beforeEach(() => {
  built.count = 0;
});

describe("model.provider none", () => {
  it("validates without a model id and asks for no credential", () => {
    const config = loadConfig({ root: makeRepo(), env: { DELTA_PEACOCK_MODEL_PROVIDER: "none" } });
    expect(config.model.provider).toBe("none");
    expect(config.model.id).toBeUndefined();
  });

  it("refuses every setting that would still call a model", () => {
    const repo = makeRepo();
    const env = {
      DELTA_PEACOCK_MODEL_PROVIDER: "none",
      DELTA_PEACOCK_CALIBRATION_ENABLED: "true",
      DELTA_PEACOCK_ENSEMBLE_ENABLED: "true",
      DELTA_PEACOCK_ENSEMBLE_MEMBERS: '[{"provider":"anthropic","id":"m"}]',
      DELTA_PEACOCK_CONTEXT_RAG_BACKEND: "embeddings",
      DELTA_PEACOCK_CONTEXT_RAG_MODEL: "e",
      DELTA_PEACOCK_CONTEXT_RAG_BASE_URL: "http://localhost:1/v1",
    };
    expect(() => loadConfig({ root: repo, env })).toThrow(
      /ensemble\.enabled calls a model, and model\.provider is none/,
    );
    try {
      loadConfig({ root: repo, env });
    } catch (error) {
      const problems = (error as { problems: string[] }).problems.join("\n");
      expect(problems).toContain("calibration.enabled calls a model");
      expect(problems).toContain("context.rag.backend embeddings calls a model");
    }
  });

  it("builds no model port: the builder itself refuses", () => {
    const config = loadConfig({ root: makeRepo(), env: { DELTA_PEACOCK_MODEL_PROVIDER: "none" } });
    expect(() => buildModelPort(config, {})).toThrow(
      "model.provider is none: no model is built and none is called",
    );
  });

  it("prints a zero cost line on the none model", async () => {
    const config = loadConfig({ root: makeRepo(), env: { DELTA_PEACOCK_MODEL_PROVIDER: "none" } });
    expect(await spendLine(config, { inputTokens: 0, outputTokens: 0 }, new Date())).toBe(
      "cost: 0 tokens in, 0 out on none, 0.0000 USD; no model call",
    );
  });
});

describe("a facts only review", () => {
  it("checks facts, leaves each judgement to a person, and never builds or calls a model", async () => {
    const repo = scenario();
    const { code, out, err, calls } = await run(repo, ["review", "--report", "review.json"]);
    expect(calls).toHaveLength(0);
    expect(built.count).toBe(0);
    expect(code).toBe(0);
    const report = JSON.parse(readFileSync(path.join(repo, "review.json"), "utf8")) as ReviewReport;
    expect(report.findings.map((one) => `${one.file}:${String(one.line)}`)).toEqual([
      "pages/list.ts:3",
    ]);
    expect(report.factsOnly?.notReviewed).toEqual(["no-console"]);
    const left = report.factsOnly?.leftToPerson ?? [];
    expect(left.map((one) => `${one.file}:${String(one.line)} ${one.guidelineId}`).sort()).toEqual([
      "pages/list.ts:7 prefer-test-ids",
      "src/app.ts:1 no-magic-numbers",
      "src/app.ts:3 no-magic-numbers",
    ]);
    expect(left.find((one) => one.file === "pages/list.ts")?.question).toBe(SELECTOR_QUESTION);
    expect(report.checks).toEqual({
      candidates: 4,
      findings: 1,
      dropped: 0,
      judgeFailed: 0,
      left: 3,
    });
    expect(report.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(err).toContain(
      "facts only: model.provider is none; 2 checked guideline(s) reviewed, 1 not reviewed: no-console",
    );
    expect(err).toContain(
      `check: pages/list.ts:7 prefer-test-ids css: left to a person: needs a judgement: ${SELECTOR_QUESTION}`,
    );
    expect(err).not.toContain("budget:");
    expect(err).toContain("cost: 0 tokens in, 0 out on none, 0.0000 USD; no model call");
    expect(out).toContain(
      `left to a person: needs a judgement: pages/list.ts:7 [prefer-test-ids] ${SELECTOR_QUESTION}`,
    );
    expect(out).toContain(
      "This review checked facts only, with no model: 1 finding, 3 candidates left to a person because they need a judgement, and 1 guideline not reviewed (no-console).",
    );
  });

  it("records model none, zero tokens and zero cost in the stats ledger", async () => {
    const repo = scenario();
    await run(repo, ["review"]);
    const review = readFileSync(path.join(repo, "delta-peacock.stats.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { kind: string; model?: string; tokens?: unknown; cost?: number },
      )
      .find((line) => line.kind === "review");
    expect(review?.model).toBe("none");
    expect(review?.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(review?.cost).toBe(0);
  });

  it("posts comments only for facts, and a summary and status that say facts only", async () => {
    const repo = scenario();
    const { scm, posted } = recordingScm();
    const { code, calls } = await run(repo, ["review"], {
      env: {
        DELTA_PEACOCK_SCM_PROVIDER: "github",
        DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
        DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
      },
      scmPort: scm,
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(built.count).toBe(0);
    expect(posted.inline).toHaveLength(1);
    expect(posted.summary[0]?.split("\n")[0]).toBe(
      "This review checked facts only, with no model: 1 finding, 3 candidates left to a person because they need a judgement, and 1 guideline not reviewed (no-console).",
    );
    expect(posted.summary.join("\n")).not.toMatch(/No issues found|Passed/);
    expect(posted.status).toEqual([
      {
        state: "success",
        description:
          "Facts only, no model. 1 finding, 3 left to a person, 1 guideline not reviewed.",
      },
    ]);
  });

  it("posts its summary even where a clean insights card would carry the result", async () => {
    const { scm, posted } = recordingScm();
    const cards: string[] = [];
    await publishReview(
      {
        ...scm,
        publishInsights: (report) => {
          cards.push(report.details);
          return Promise.resolve();
        },
      },
      {
        findings: [],
        proposals: [],
        droppedUncited: 0,
        filtered: 0,
        gate: evaluateGate([], "MAJOR"),
        commitStatus: true,
        codeInsights: true,
        dryRun: false,
        factsOnly: { left: 1, notReviewed: [] },
      },
    );
    const line =
      "This review checked facts only, with no model: 0 findings, 1 candidate left to a person because it needs a judgement, and every applicable guideline checked.";
    expect(posted.summary.map((body) => body.split("\n")[0])).toEqual([line]);
    expect(cards).toEqual([line]);
    expect(posted.status[0]?.description).toBe(
      "Facts only, no model. 0 findings, 1 left to a person, 0 guidelines not reviewed.",
    );
  });

  it("never gates on a candidate left to a person", async () => {
    const repo = scenario(CONFIG.replace("failOn: MAJOR", "failOn: MINOR"));
    write(repo, "pages/list.ts", PAGE.replace("locator('.tile')", "getByTestId('tile')"));
    write(repo, "src/app.ts", APP.replace("const RETRY_LIMIT = 3;", "const RETRY_LIMIT = 1;"));
    commitAll(repo, "only judged candidates left");
    const { code, err } = await run(repo, ["review", "--report", "review.json"]);
    const report = JSON.parse(readFileSync(path.join(repo, "review.json"), "utf8")) as ReviewReport;
    expect(report.findings).toEqual([]);
    expect(report.factsOnly?.leftToPerson).toHaveLength(2);
    expect(code).toBe(0);
    expect(err).not.toContain("gate: failOn=MINOR FAILED");
  });
});

describe("commands that need a model", () => {
  it.each([
    ["ask", ["ask", "what changed?"]],
    ["describe", ["describe", "--dry-run"]],
    ["learn", ["learn", "--dry-run"]],
    ["audit", ["audit"]],
  ])("%s refuses with one line and exit code 1", async (name, argv) => {
    const repo = scenario();
    const { code, out, err, calls } = await run(repo, argv);
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(built.count).toBe(0);
    expect(out).toBe("");
    expect(err).toBe(
      `${name} needs a model, and model.provider is none; set a provider to use it\n`,
    );
  });

  it("calibration refuses before any work", async () => {
    const repo = scenario(`${CONFIG}calibration:\n  enabled: true\n`);
    const { code, err, calls } = await run(repo, ["review"]);
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(err).toContain(
      "calibration.enabled calls a model, and model.provider is none; turn it off or set a provider",
    );
  });
});

describe("setting up without a model", () => {
  it("doctor passes the model check with no credential", async () => {
    const repo = scenario();
    const { code, out } = await run(repo, ["doctor"]);
    expect(out).toContain(
      "model: none: no model is called and no credential is needed; a review checks facts only",
    );
    expect(code).toBe(0);
  });

  it("the walkthrough writes provider none and skips the model questions", async () => {
    const repo = makeRepo();
    const answers = ["", "none", "", "", null];
    let out = "";
    const code = await runCli(["init", "--walkthrough"], {
      cwd: repo,
      env: {},
      out: (text) => {
        out += text;
      },
      err: () => undefined,
      readLine: () => Promise.resolve(answers.shift() ?? null),
    });
    expect(code).toBe(0);
    const config = readFileSync(path.join(repo, "delta-peacock.config.yaml"), "utf8");
    expect(config).toContain("  provider: none");
    expect(config).not.toContain("id:");
    expect(out).not.toContain("context strategy");
    const steps = out.slice(out.indexOf("next steps"));
    expect(steps).toContain("bind mechanical guidelines to a check under review.checks");
    expect(steps).not.toContain("ANTHROPIC_API_KEY");
    const snippet = readFileSync(path.join(repo, "delta-peacock-ci-snippet.txt"), "utf8");
    expect(snippet).not.toMatch(/ANTHROPIC_API_KEY|DELTA_PEACOCK_MODEL_ID/);
    expect(snippet).toContain("DELTA_PEACOCK_SCM_PROVIDER");
  });

  it.each(["local", "github", "gitlab", "bitbucket"] as const)(
    "the %s scaffold asks for no model credential",
    (scm) => {
      const files = planScaffold({ ...DEFAULT_ANSWERS, scm, provider: "none" });
      for (const file of files) {
        expect(file.content).not.toMatch(/ANTHROPIC_API_KEY|DELTA_PEACOCK_MODEL_ID/);
      }
      expect(files[2]?.content).toMatch(/TOKEN/);
    },
  );

  it("a jenkins snippet keeps only the SCM token", () => {
    const snippet = withoutModelCredentials({
      relPath: "x",
      content:
        "// provide ANTHROPIC_API_KEY, the SCM token and DELTA_PEACOCK_MODEL_ID via credentials",
    });
    expect(snippet.content).toBe("// provide the SCM token via credentials");
  });
});
