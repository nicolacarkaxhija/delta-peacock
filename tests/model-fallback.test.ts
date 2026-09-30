import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config/schema.js";
import { runCli } from "../src/index.js";
import type { ModelPort } from "../src/model/port.js";
import { unavailability } from "../src/model/unavailable.js";
import type { ReviewReport } from "../src/review/report.js";
import { evaluateGate } from "../src/domain/gate.js";
import { DEFAULT_PRESENTATION, factsLine, isSummaryBody } from "../src/scm/comment-format.js";
import type { ScmPort } from "../src/scm/port.js";
import { buildInsightReport } from "../src/scm/publish.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

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

const APP = [
  "const RETRY_LIMIT = 3;",
  "// the rows on one page",
  "const PAGE_ROWS = 25;",
  "export function run(): number {",
  "  console.log(PAGE_ROWS);",
  "  return RETRY_LIMIT;",
  "}",
  "",
].join("\n");

function config(
  options: {
    id?: boolean;
    failOn?: string;
    fallback?: Record<string, string>;
    model?: string[];
    review?: string[];
  } = {},
): string {
  const fallback = Object.entries(options.fallback ?? {});
  return [
    "model:",
    ...(options.model ?? [
      "  provider: anthropic",
      ...(options.id === false ? [] : ["  id: some-model"]),
    ]),
    "review:",
    "  target: main",
    "  fetchTarget: false",
    ...(options.review ?? []),
    "  checks:",
    "    no-magic-numbers: numbers",
    "gate:",
    `  failOn: ${options.failOn ?? "none"}`,
    ...(fallback.length > 0
      ? ["fallback:", ...fallback.map(([key, value]) => `  ${key}: ${value}`)]
      : []),
    "",
  ].join("\n");
}

const APPROVAL = "Facts only, no model: needs a person's approval";

function scenario(configText = config()): string {
  const repo = makeRepo();
  write(repo, "guidelines/no-magic-numbers.md", NUMBERS);
  write(repo, "guidelines/no-console.md", CONSOLE);
  write(repo, "delta-peacock.config.yaml", configText);
  commitAll(repo, "guidelines");
  git(repo, "checkout", "-q", "-b", "feature");
  write(repo, "src/app.ts", APP);
  commitAll(repo, "change");
  return repo;
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

/** A pull request that keeps its comments from one run to the next. */
function pullRequest(): {
  host: () => { scm: ScmPort; posted: Posted };
  comments: Map<string, { body: string; path: string; line: number }>;
} {
  const comments = new Map<string, { body: string; path: string; line: number }>();
  const summaries = new Map<string, string>();
  let next = 0;
  const host = (): { scm: ScmPort; posted: Posted } => {
    const { scm, posted } = recordingScm();
    return {
      posted,
      scm: {
        ...scm,
        listInlineComments: () =>
          Promise.resolve([...comments].map(([id, comment]) => ({ id, ...comment }))),
        createInlineComment: (comment) => {
          next += 1;
          comments.set(String(next), {
            body: comment.body,
            path: comment.path,
            line: comment.line,
          });
          posted.inline.push(comment.body);
          return Promise.resolve(String(next));
        },
        updateComment: (id, body) => {
          const comment = comments.get(id);
          if (comment !== undefined) comments.set(id, { ...comment, body });
          return Promise.resolve();
        },
        listSummaryComments: () =>
          Promise.resolve([...summaries].map(([id, body]) => ({ id, body }))),
        createSummaryComment: (body) => {
          summaries.set("summary", body);
          posted.summary.push(body);
          return Promise.resolve();
        },
        updateSummaryComment: (id, body) => {
          summaries.set(id, body);
          posted.summary.push(body);
          return Promise.resolve();
        },
      },
    };
  };
  return { host, comments };
}

interface Run {
  code: number;
  out: string;
  err: string;
  posted: Posted;
  report: ReviewReport | undefined;
}

async function review(
  repo: string,
  port: ModelPort | undefined,
  env: Record<string, string> = {},
  host: { scm: ScmPort; posted: Posted } = recordingScm(),
): Promise<Run> {
  let out = "";
  let err = "";
  const { scm, posted } = host;
  const code = await runCli(["review", "--report", "review.json"], {
    cwd: repo,
    env: {
      DELTA_PEACOCK_SCM_PROVIDER: "github",
      DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
      DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
      ...env,
    },
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    ...(port !== undefined ? { modelPort: port } : {}),
    scmPort: scm,
  });
  let report: ReviewReport | undefined;
  try {
    report = JSON.parse(readFileSync(path.join(repo, "review.json"), "utf8")) as ReviewReport;
  } catch {
    report = undefined;
  }
  return { code, out, err, posted, report };
}

const failing = (error: Error): ModelPort => ({ complete: () => Promise.reject(error) });

const apiError = (statusCode: number | undefined, message: string, cause?: unknown): APICallError =>
  new APICallError({
    message,
    url: "https://api.example.com/v1/messages",
    requestBodyValues: {},
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(cause !== undefined ? { cause } : {}),
  });

const connectionRefused = (): APICallError =>
  apiError(
    undefined,
    "Cannot connect to API: fetch failed",
    Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
        code: "ECONNREFUSED",
      }),
    }),
  );

const rateLimited = (): RetryError =>
  new RetryError({
    message: "Failed after 6 attempts. Last error: rate_limit_error",
    reason: "maxRetriesExceeded",
    errors: [apiError(429, "rate_limit_error: Number of requests has exceeded your rate limit")],
  });

const keyRejected = (): APICallError => apiError(401, "invalid x-api-key");

const timedOut = (): Error =>
  Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

const finding = JSON.stringify({
  findings: [
    {
      guidelineId: "no-console",
      file: "src/app.ts",
      line: 5,
      quote: "console.log(PAGE_ROWS);",
      title: "Console call added",
      body: "Replace the console.log with the logger.",
      guidelineQuote: "Use the logger instead.",
    },
  ],
});

describe("what counts as a model that cannot run", () => {
  it.each([
    ["a refused connection", connectionRefused(), "unreachable"],
    ["an overloaded provider", apiError(529, "Overloaded"), "unreachable"],
    ["a rate limit after the retries", rateLimited(), "limit"],
    ["a throttled call", apiError(400, "ThrottlingException: Too many tokens"), "limit"],
    ["a spent quota", apiError(400, "Your credit balance is too low"), "limit"],
    ["an abort on timeout", timedOut(), "timeout"],
    [
      "a header timeout",
      apiError(
        undefined,
        "Cannot connect to API: fetch failed",
        Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("Headers Timeout Error"), {
            code: "UND_ERR_HEADERS_TIMEOUT",
          }),
        }),
      ),
      "timeout",
    ],
  ])("%s", (_, error, expected) => {
    expect(unavailability(error, "fallback")).toBe(expected);
  });

  it.each([
    ["a bad request", apiError(400, "max_tokens: must be at most 8192, a timeout of 5 s")],
    ["a plain bug", new TypeError("Cannot read properties of undefined")],
  ])("%s is no fallback", (_, error) => {
    expect(unavailability(error, "fallback")).toBeUndefined();
  });

  const refusals: [string, Error][] = [
    ["a 401", keyRejected()],
    ["a 403", apiError(403, "The security token included in the request is invalid.")],
    ["a rejected key with no status", new Error("Incorrect API key provided: sk-...")],
  ];

  it.each(refusals)("%s is a refused credential by default", (_, error) => {
    expect(unavailability(error, "fallback")).toBe("credential-refused");
  });

  it.each(refusals)("%s is no fallback with credentialRefused fail", (_, error) => {
    expect(unavailability(error, "fail")).toBeUndefined();
  });
});

describe("a review whose model cannot run", () => {
  it.each([
    [
      "unreachable",
      failing(connectionRefused()),
      "the model provider could not be reached",
      "unreachable",
    ],
    [
      "limit",
      failing(rateLimited()),
      "the model provider answered with a rate or quota limit",
      "rate or quota limit",
    ],
    ["timeout", failing(timedOut()), "the model call timed out", "timed out"],
  ])(
    "falls back to facts only on %s, passes the step and asks for a person",
    async (why, port, reason, short) => {
      const { code, err, posted, report } = await review(scenario(), port);
      expect(code).toBe(0);
      expect(err).toContain(`model unavailable (${short}): `);
      expect(report?.factsOnly?.fallback).toBe(why);
      expect(report?.findings.map((one) => `${one.file}:${String(one.line)}`)).toEqual([
        "src/app.ts:1",
      ]);
      expect(report?.factsOnly?.leftToPerson.map((one) => one.line)).toEqual([3]);
      expect(posted.inline).toHaveLength(1);
      expect(posted.summary[0]?.split("\n")[0]).toBe(
        `The model could not run (${reason}), so this review checked facts only: 1 finding, 1 candidate left to a person because it needs a judgement, and 1 guideline not reviewed (no-console). Merging needs a person's approval.`,
      );
      expect(posted.status).toEqual([{ state: "success", description: APPROVAL }]);
    },
  );

  it("falls back when no model is configured", async () => {
    const { code, posted, report } = await review(scenario(config({ id: false })), undefined);
    expect(code).toBe(0);
    expect(report?.factsOnly?.fallback).toBe("not-configured");
    expect(posted.status).toEqual([{ state: "success", description: APPROVAL }]);
    expect(posted.summary[0]?.split("\n")[0]).toMatch(
      /^The model could not run \(no model is configured\), so this review checked facts only: /,
    );
  });

  it("falls back when the provider credential is missing", async () => {
    const { code, posted, err } = await review(scenario(), undefined);
    expect(code).toBe(0);
    expect(err).toContain("model unavailable (not configured): ANTHROPIC_API_KEY is not set");
    expect(posted.status[0]?.state).toBe("success");
  });

  it("leaves a candidate to a person when only the judge cannot reach the model", async () => {
    const port: ModelPort = {
      complete: (request) =>
        request.system.startsWith("You are delta-peacock's judge")
          ? Promise.reject(rateLimited())
          : Promise.resolve({ text: finding }),
    };
    const { code, posted, report } = await review(scenario(), port);
    expect(code).toBe(0);
    expect(report?.factsOnly?.fallback).toBe("limit");
    expect(report?.findings.map((one) => `${one.file}:${String(one.line)}`).sort()).toEqual([
      "src/app.ts:1",
      "src/app.ts:5",
    ]);
    expect(report?.factsOnly?.leftToPerson.map((one) => one.line)).toEqual([3]);
    expect(report?.factsOnly?.notReviewed).toEqual([]);
    expect(report?.checks?.judgeFailed).toBe(0);
    expect(posted.status[0]?.state).toBe("success");
  });
});

describe("fallback.gate", () => {
  it.each([
    ["by default", {}],
    ["with facts", { gate: "facts" }],
  ])("%s a fact finding that reaches the gate fails the step", async (_, fallback) => {
    const { code, posted, report } = await review(
      scenario(config({ failOn: "MINOR", fallback })),
      failing(connectionRefused()),
    );
    expect(code).toBe(2);
    expect(report?.gate.failed).toBe(true);
    expect(posted.status).toEqual([
      {
        state: "failure",
        description:
          "No model (unreachable), facts only: 1 finding, 1 left to a person. Needs a person's approval.",
      },
    ]);
  });

  it("with pass the step passes whatever the facts found, and the findings stand", async () => {
    const { code, posted, report } = await review(
      scenario(config({ failOn: "MINOR", fallback: { gate: "pass" } })),
      failing(connectionRefused()),
    );
    expect(code).toBe(0);
    expect(report?.gate.failed).toBe(false);
    expect(report?.findings.map((one) => `${one.file}:${String(one.line)}`)).toEqual([
      "src/app.ts:1",
    ]);
    expect(posted.inline).toHaveLength(1);
    expect(posted.summary[0]).toContain("src/app.ts");
    expect(posted.summary[0]).not.toContain("Blocked");
    expect(posted.status).toEqual([{ state: "success", description: APPROVAL }]);
  });

  it("with pass a review whose model runs still fails on its findings", async () => {
    const port: ModelPort = {
      complete: (request) =>
        Promise.resolve({
          text: request.system.startsWith("You are delta-peacock's judge")
            ? JSON.stringify({ verdict: "confirm", kind: "limit" })
            : finding,
        }),
    };
    const { code } = await review(
      scenario(config({ failOn: "MINOR", fallback: { gate: "pass" } })),
      port,
    );
    expect(code).toBe(2);
  });
});

describe("fallback.status", () => {
  it.each([
    ["by default", {}],
    ["with success", { status: "success" }],
  ])("%s posts success and asks for a person's approval", async (_, fallback) => {
    const { code, posted } = await review(
      scenario(config({ fallback })),
      failing(connectionRefused()),
    );
    expect(code).toBe(0);
    expect(posted.status).toEqual([{ state: "success", description: APPROVAL }]);
    expect(posted.summary[0]?.split("\n")[0]).toMatch(/ Merging needs a person's approval\.$/);
  });

  it("with pending posts pending and asks for a person's approval", async () => {
    const { code, posted } = await review(
      scenario(config({ fallback: { status: "pending" } })),
      failing(connectionRefused()),
    );
    expect(code).toBe(0);
    expect(posted.status).toEqual([
      {
        state: "pending",
        description:
          "No model (unreachable), facts only: 1 finding, 1 left to a person. Needs a person's approval.",
      },
    ]);
    expect(posted.summary[0]?.split("\n")[0]).toMatch(/ Merging needs a person's approval\.$/);
  });
});

describe("fallback.credentialRefused", () => {
  it.each([
    ["by default", {}],
    ["with fallback", { credentialRefused: "fallback" }],
  ])("%s a refused credential falls back and names the reason", async (_, fallback) => {
    const { code, err, posted, report } = await review(
      scenario(config({ fallback })),
      failing(keyRejected()),
    );
    expect(code).toBe(0);
    expect(err).toContain(
      "model unavailable (credential refused): model call failed: invalid x-api-key",
    );
    expect(report?.factsOnly?.fallback).toBe("credential-refused");
    expect(posted.summary[0]?.split("\n")[0]).toMatch(
      /^The model could not run \(the credential was refused\), so this review checked facts only: /,
    );
    expect(posted.status).toEqual([{ state: "success", description: APPROVAL }]);
  });

  it("by default a judge whose credential is refused leaves its candidate to a person", async () => {
    const port: ModelPort = {
      complete: (request) =>
        request.system.startsWith("You are delta-peacock's judge")
          ? Promise.reject(keyRejected())
          : Promise.resolve({ text: finding }),
    };
    const { code, report } = await review(scenario(), port);
    expect(code).toBe(0);
    expect(report?.factsOnly?.fallback).toBe("credential-refused");
    expect(report?.factsOnly?.leftToPerson.map((one) => one.line)).toEqual([3]);
  });

  it("with fail the run fails as before on a rejected key", async () => {
    const { code, posted, err } = await review(
      scenario(config({ fallback: { credentialRefused: "fail" } })),
      failing(keyRejected()),
    );
    expect(code).toBe(1);
    expect(err).toContain("model call failed: invalid x-api-key");
    expect(posted.status[0]?.state).toBe("failure");
    expect(posted.summary[0]).toMatch(/^The review could not complete: /);
  });

  it("with fail a judge whose credential is refused fails its candidate as before", async () => {
    const port: ModelPort = {
      complete: (request) =>
        request.system.startsWith("You are delta-peacock's judge")
          ? Promise.reject(keyRejected())
          : Promise.resolve({ text: finding }),
    };
    const { report } = await review(
      scenario(config({ fallback: { credentialRefused: "fail" } })),
      port,
    );
    expect(report?.factsOnly).toBeUndefined();
    expect(report?.checks?.judgeFailed).toBe(2);
  });
});

describe("where a host shows the fallback", () => {
  const input = (fallbackStatus: "success" | "pending") => ({
    findings: [],
    proposals: [],
    droppedUncited: 0,
    filtered: 0,
    gate: evaluateGate([], "MAJOR"),
    factsOnly: { left: 1, notReviewed: [], fallback: "unreachable" as const, fallbackStatus },
  });

  it("a Code Insights card reads passed with fallback.status success", () => {
    expect(buildInsightReport(input("success")).result).toBe("PASSED");
  });

  it("a Code Insights card reads pending with fallback.status pending", () => {
    expect(buildInsightReport(input("pending")).result).toBe("PENDING");
  });

  it("a rerun finds its own fallback summary where the host shows no markers", () => {
    const line = factsLine(0, input("success").factsOnly);
    expect(isSummaryBody(line, { ...DEFAULT_PRESENTATION, markers: false })).toBe(true);
  });
});

describe("a review whose model runs", () => {
  it("posts, gates and exits exactly as before", async () => {
    const judged = { verdict: "confirm", kind: "limit" };
    const port: ModelPort = {
      complete: (request) =>
        Promise.resolve({
          text: request.system.startsWith("You are delta-peacock's judge")
            ? JSON.stringify(judged)
            : finding,
        }),
    };
    const { code, posted, report, out } = await review(scenario(config({ failOn: "MAJOR" })), port);
    expect(code).toBe(2);
    expect(report?.factsOnly).toBeUndefined();
    expect(out).not.toContain("facts only");
    expect(posted.status).toEqual([
      { state: "failure", description: "3 findings, 1 major. See the comments." },
    ]);
    expect(posted.summary[0]?.split("\n")[0]).toBe("3 findings: 1 major, 2 minor");
  });
});

const isJudge = (system: string): boolean => system.startsWith("You are delta-peacock's judge");

/** A model that answers: the open review finds the console call, the judge confirms. */
const answering = (
  open: (user: string) => Promise<string> = () => Promise.resolve(finding),
  judge: () => Promise<string> = () =>
    Promise.resolve(JSON.stringify({ verdict: "confirm", kind: "limit" })),
): ModelPort => ({
  complete: async (request) => ({
    text: isJudge(request.system) ? await judge() : await open(request.user),
  }),
});

describe("comments an earlier model run posted", () => {
  it("stay as they are through an outage, and the model's return adds none twice", async () => {
    const repo = scenario();
    const pr = pullRequest();
    await review(repo, answering(), {}, pr.host());
    const posted = new Map(pr.comments);
    expect([...posted.values()].map((one) => one.line).sort()).toEqual([1, 3, 5]);

    const outage = await review(repo, failing(connectionRefused()), {}, pr.host());
    expect(outage.code).toBe(0);
    expect(pr.comments).toEqual(posted);
    expect(outage.posted.summary.at(-1)).toContain(
      "Not judged again on this run, so their comments stay as they are: src/app.ts:3, src/app.ts:5.",
    );

    const back = await review(repo, answering(), {}, pr.host());
    expect(back.posted.inline).toEqual([]);
    expect(pr.comments).toEqual(posted);
  });
});

describe("an outage in one batch", () => {
  it("keeps what the answered batches found and names the files no model reviewed", async () => {
    const repo = scenario(config({ review: ["  maxFilesPerBatch: 1"] }));
    write(repo, "src/other.ts", "export const other = (): void => {\n  console.log(1);\n};\n");
    commitAll(repo, "another file");
    const port = answering((user) =>
      user.includes("+++ b/src/other.ts")
        ? Promise.reject(connectionRefused())
        : Promise.resolve(finding),
    );
    const { code, posted, report } = await review(repo, port);
    expect(code).toBe(0);
    expect(report?.findings.map((one) => `${one.file}:${String(one.line)}`).sort()).toEqual([
      "src/app.ts:1",
      "src/app.ts:5",
    ]);
    expect(report?.factsOnly?.modelReviewed).toBe("part");
    expect(report?.factsOnly?.unjudgedFiles).toEqual(["src/other.ts"]);
    expect(posted.summary[0]?.split("\n")[0]).toBe(
      "The model reviewed part of the change, then could not run (the model provider could not be reached): no model reviewed src/other.ts, where this review checked facts only. 2 findings, 1 candidate left to a person because it needs a judgement, and 1 guideline not reviewed on those files (no-console). Merging needs a person's approval.",
    );
    expect(posted.status).toEqual([
      { state: "success", description: "Model reviewed in part: needs a person's approval" },
    ]);
  });

  it("is a fallback when it hits the retry for a readable answer", async () => {
    let calls = 0;
    const port = answering(() => {
      calls += 1;
      return calls === 1 ? Promise.resolve("no json here") : Promise.reject(connectionRefused());
    });
    const { code, err, report } = await review(scenario(), port);
    expect(code).toBe(0);
    expect(err).toContain("model unavailable (unreachable): model call failed: Cannot connect");
    expect(report?.factsOnly?.fallback).toBe("unreachable");
  });
});

const SIX = [
  "export const RETRY_LIMIT = 3;",
  "export const PAGE_ROWS = 25;",
  "export const BATCH_ROWS = 50;",
  "export const GRID_ROWS = 12;",
  "export const LIST_ROWS = 40;",
  "export const TABLE_ROWS = 30;",
  "",
].join("\n");

describe("a judge that cannot run after the model reviewed", () => {
  it("asks the model once in the run, then leaves the rest to a person", async () => {
    const repo = scenario();
    write(repo, "src/app.ts", SIX);
    commitAll(repo, "six numbers");
    let judged = 0;
    const port = answering(undefined, () => {
      judged += 1;
      return Promise.reject(rateLimited());
    });
    const { code, report, posted } = await review(repo, port);
    expect(code).toBe(0);
    expect(judged).toBe(1);
    expect(report?.factsOnly?.modelReviewed).toBe("all");
    expect(report?.factsOnly?.leftToPerson).toHaveLength(5);
    expect(posted.summary[0]?.split("\n")[0]).toBe(
      "The model reviewed the change, but the judge could not run (the model provider answered with a rate or quota limit): 2 findings, and 5 candidates left to a person because they need a judgement. Merging needs a person's approval.",
    );
    expect(posted.status).toEqual([
      { state: "success", description: "Judge could not run: needs a person's approval" },
    ]);
  });

  it("with fallback.gate pass still gates on the model's own finding", async () => {
    const port = answering(undefined, () => Promise.reject(rateLimited()));
    const { code, posted } = await review(
      scenario(config({ failOn: "MAJOR", fallback: { gate: "pass" } })),
      port,
    );
    expect(code).toBe(2);
    expect(posted.status[0]?.state).toBe("failure");
  });
});

describe("model.timeoutSeconds", () => {
  it("defaults to 60 seconds per request", () => {
    expect(ConfigSchema.parse({}).model.timeoutSeconds).toBe(60);
  });

  it("falls back when the provider takes the request and never answers", async () => {
    const server = createServer(() => {
      // takes the request and never answers
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const repo = scenario(
        config({
          model: [
            "  provider: openai-compatible",
            "  id: some-model",
            `  baseUrl: http://127.0.0.1:${String(port)}/v1`,
            "  timeoutSeconds: 0.2",
          ],
        }),
      );
      const started = Date.now();
      const { code, err } = await review(repo, undefined);
      expect(code).toBe(0);
      expect(err).toContain("model unavailable (timed out)");
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
