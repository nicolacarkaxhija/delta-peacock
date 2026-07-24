import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import type { ModelPort, ModelRequest } from "../src/model/port.js";
import { renderCommentBody } from "../src/scm/publish.js";
import { startFakeBitbucket } from "./helpers/fake-bitbucket.js";
import { startFakeGitHub, type FakeGitHub } from "./helpers/fake-github.js";
import { makeRepo } from "./helpers/git.js";

const DRAFT_REPLY = JSON.stringify({
  drafts: [
    {
      id: "prefer-early-returns",
      severity: "MINOR",
      title: "Prefer early returns",
      body: "Guard clauses over nested conditionals; return as soon as the answer is known.",
      rationale: "Three accepted observations proposed it across recent reviews.",
      languages: ["javascript", "typescript"],
    },
  ],
});

function githubEnv(baseUrl: string): Record<string, string> {
  return {
    DELTA_PEACOCK_SCM_PROVIDER: "github",
    DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
    DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
    DELTA_PEACOCK_SCM_BASE_URL: baseUrl,
    GITHUB_TOKEN: "test-token",
  };
}

/** Marker-carrying comments the way the reviewer itself renders them. */
function seedSignals(fake: FakeGitHub): void {
  fake.reviewComments.push(
    {
      id: 1,
      body: renderCommentBody(
        {
          kind: "violation",
          guidelineId: "no-console",
          severity: "MAJOR",
          file: "src/app.js",
          line: 3,
          title: "Console call committed",
          body: "Route it through the logger.",
        },
        "aaaa11112222",
      ),
      path: "src/app.js",
      reactions: { "+1": 2 },
    },
    {
      id: 2,
      body: renderCommentBody(
        {
          kind: "observation",
          severity: "MINOR",
          file: "src/app.js",
          line: 9,
          title: "Deep nesting",
          body: "An early return would read better.",
        },
        "bbbb33334444",
      ),
      path: "src/app.js",
      reactions: { "-1": 1 },
    },
    { id: 3, body: "totally human comment, no marker", path: "src/app.js" },
    { id: 4, body: "I disagree, this is fine in tests", in_reply_to_id: 2 },
  );
}

function capture(reply = DRAFT_REPLY): { requests: ModelRequest[]; port: ModelPort } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    port: {
      complete(request) {
        requests.push(request);
        return Promise.resolve({ text: reply });
      },
    },
  };
}

async function runLearnCli(
  env: Record<string, string>,
  port: ModelPort,
  args: string[] = [],
  cwd = makeRepo(),
): Promise<{ code: number; stdout: string; stderr: string; cwd: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["learn", ...args], {
    cwd,
    env,
    out: (text) => {
      stdout += text;
    },
    err: (text) => {
      stderr += text;
    },
    modelPort: port,
  });
  return { code, stdout, stderr, cwd };
}

describe("learn on github", () => {
  it("collects reactions and replies, writes loader-valid drafts", async () => {
    const fake = await startFakeGitHub();
    try {
      seedSignals(fake);
      const { requests, port } = capture();
      const { code, stdout, cwd } = await runLearnCli(githubEnv(fake.baseUrl), port);
      expect(code).toBe(0);
      expect(stdout).toContain("draft written");
      expect(stdout).toContain("2 signal(s), 1 draft(s)");

      // the model saw the marker fingerprints, thumbs and the pushback reply
      const sent = requests[0]?.user ?? "";
      expect(sent).toContain("aaaa11112222");
      expect(sent).toContain('"up": 2');
      expect(sent).toContain('"down": 1');
      expect(sent).toContain("I disagree, this is fine in tests");
      expect(sent).toContain('"guidelineId": "no-console"');
      expect(sent).not.toContain("totally human comment");

      // the draft is a guideline the loader accepts unchanged
      const draftsDir = path.join(cwd, "guidelines-drafts");
      expect(existsSync(path.join(draftsDir, "prefer-early-returns.md"))).toBe(true);
      const lint = await runCli(["guidelines", "lint", "--guidelines-dir", "guidelines-drafts"], {
        cwd,
        env: {},
        out: () => undefined,
        err: () => undefined,
      });
      expect(lint).toBe(0);
    } finally {
      await fake.close();
    }
  });

  it("is idempotent: a re-run overwrites the same draft file", async () => {
    const fake = await startFakeGitHub();
    try {
      seedSignals(fake);
      const cwd = makeRepo();
      await runLearnCli(githubEnv(fake.baseUrl), capture().port, [], cwd);
      await runLearnCli(githubEnv(fake.baseUrl), capture().port, [], cwd);
      const { readdirSync } = await import("node:fs");
      expect(readdirSync(path.join(cwd, "guidelines-drafts"))).toEqual(["prefer-early-returns.md"]);
    } finally {
      await fake.close();
    }
  });

  it("writes the evidence report and honors --drafts-dir", async () => {
    const fake = await startFakeGitHub();
    try {
      seedSignals(fake);
      const { port } = capture();
      const { code, cwd } = await runLearnCli(githubEnv(fake.baseUrl), port, [
        "--drafts-dir",
        "proposals",
        "--report",
        "learn.json",
      ]);
      expect(code).toBe(0);
      expect(existsSync(path.join(cwd, "proposals", "prefer-early-returns.md"))).toBe(true);
      const report = JSON.parse(readFileSync(path.join(cwd, "learn.json"), "utf8")) as {
        evidence: { fingerprint: string }[];
        drafts: string[];
      };
      expect(report.evidence).toHaveLength(2);
      expect(report.drafts).toEqual(["prefer-early-returns.md"]);
    } finally {
      await fake.close();
    }
  });

  it("does nothing without reviewer comments", async () => {
    const fake = await startFakeGitHub();
    try {
      fake.reviewComments.push({ id: 1, body: "human words only" });
      const { requests, port } = capture();
      const { code, stdout } = await runLearnCli(githubEnv(fake.baseUrl), port);
      expect(code).toBe(0);
      expect(stdout).toContain("nothing to learn");
      expect(requests).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });

  it("dry run collects evidence but never calls the model", async () => {
    const fake = await startFakeGitHub();
    try {
      seedSignals(fake);
      const { requests, port } = capture();
      const { code, stdout, cwd } = await runLearnCli(githubEnv(fake.baseUrl), port, ["--dry-run"]);
      expect(code).toBe(0);
      expect(stdout).toContain("no model was called");
      expect(requests).toHaveLength(0);
      expect(existsSync(path.join(cwd, "guidelines-drafts"))).toBe(false);
    } finally {
      await fake.close();
    }
  });

  it("skips unusable drafts with a notice and says when none survive", async () => {
    const fake = await startFakeGitHub();
    try {
      seedSignals(fake);
      const { port } = capture(
        JSON.stringify({
          drafts: [
            { id: "Bad Id!", severity: "MAJOR", title: "t", body: "b", rationale: "r" },
            { id: "no-severity", severity: "HUGE", title: "t", body: "b", rationale: "r" },
            "not even an object",
          ],
        }),
      );
      const { code, stdout, stderr } = await runLearnCli(githubEnv(fake.baseUrl), port);
      expect(code).toBe(0);
      expect(stderr).toContain("unusable draft");
      expect(stdout).toContain("supports no new drafts");
    } finally {
      await fake.close();
    }
  });

  it("a reply without a drafts array is a tool error", async () => {
    const fake = await startFakeGitHub();
    try {
      seedSignals(fake);
      const { port } = capture(JSON.stringify({ proposals: [] }));
      const { code, stderr } = await runLearnCli(githubEnv(fake.baseUrl), port);
      expect(code).toBe(1);
      expect(stderr).toContain("no drafts array");
    } finally {
      await fake.close();
    }
  });
});

describe("learn cost and failure paths", () => {
  it("is blocked by the cost guard before any model call", async () => {
    const fake = await startFakeGitHub();
    try {
      seedSignals(fake);
      const { requests, port } = capture();
      const { code, stdout } = await runLearnCli(
        {
          ...githubEnv(fake.baseUrl),
          DELTA_PEACOCK_COST_RATE_INPUT_PER_1M: "1000000",
          DELTA_PEACOCK_COST_RATE_OUTPUT_PER_1M: "1000000",
          DELTA_PEACOCK_COST_MAX_PER_REVIEW: "0.000001",
        },
        port,
      );
      expect(code).toBe(1);
      expect(requests).toHaveLength(0);
      expect(stdout).toContain("blocked by the cost guard");
    } finally {
      await fake.close();
    }
  });

  it("warns when caps are set without rates and still learns", async () => {
    const fake = await startFakeGitHub();
    try {
      seedSignals(fake);
      const { requests, port } = capture();
      const { code, stderr } = await runLearnCli(
        { ...githubEnv(fake.baseUrl), DELTA_PEACOCK_COST_MAX_PER_REVIEW: "1" },
        port,
      );
      expect(code).toBe(0);
      expect(requests).toHaveLength(1);
      expect(stderr).toContain("no rates are configured");
    } finally {
      await fake.close();
    }
  });

  it("records priced usage and wraps transport failures", async () => {
    const fake = await startFakeGitHub();
    try {
      seedSignals(fake);
      const { mkdtempSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const counter = path.join(mkdtempSync(path.join(tmpdir(), "dp-learn-")), "spend.json");
      const priced: ModelPort = {
        complete: () =>
          Promise.resolve({ text: DRAFT_REPLY, usage: { inputTokens: 10, outputTokens: 5 } }),
      };
      const ok = await runLearnCli(
        {
          ...githubEnv(fake.baseUrl),
          DELTA_PEACOCK_COST_RATE_INPUT_PER_1M: "3",
          DELTA_PEACOCK_COST_RATE_OUTPUT_PER_1M: "15",
          DELTA_PEACOCK_COST_COUNTER_PATH: counter,
        },
        priced,
      );
      expect(ok.code).toBe(0);
      expect(existsSync(counter)).toBe(true);

      const transport = await runLearnCli(githubEnv(fake.baseUrl), {
        complete: () => Promise.reject(new Error("socket hangup")),
      });
      expect(transport.code).toBe(1);
      expect(transport.stderr).toContain("model call failed");

      const { ToolError } = await import("../src/errors.js");
      const passthrough = await runLearnCli(githubEnv(fake.baseUrl), {
        complete: () => Promise.reject(new ToolError("credentials missing")),
      });
      expect(passthrough.code).toBe(1);
      expect(passthrough.stderr).toContain("credentials missing");
      expect(passthrough.stderr).not.toContain("model call failed");
    } finally {
      await fake.close();
    }
  });

  it("falls back to placeholders when a marked comment has an unexpected shape", async () => {
    const fake = await startFakeGitHub();
    try {
      fake.reviewComments.push({
        id: 9,
        body: "\n<!-- delta-peacock:finding:dddd77778888 -->",
      });
      const { requests, port } = capture(JSON.stringify({ drafts: [] }));
      const { code } = await runLearnCli(githubEnv(fake.baseUrl), port);
      expect(code).toBe(0);
      const sent = requests[0]?.user ?? "";
      expect(sent).toContain("(untitled)");
      expect(sent).toContain("dddd77778888");
      expect(sent).not.toContain("guidelineId");
    } finally {
      await fake.close();
    }
  });
});

describe("draft rendering", () => {
  it("renders with and without a languages line", async () => {
    const { renderDraft } = await import("../src/guidelines/draft.js");
    const base = {
      id: "x-rule",
      severity: "MINOR" as const,
      title: "T",
      body: "B",
      rationale: "R",
    };
    expect(renderDraft({ ...base, languages: ["javascript"] })).toContain(
      "languages: [javascript]",
    );
    expect(renderDraft(base)).not.toContain("languages:");
    expect(renderDraft({ ...base, languages: [] })).not.toContain("languages:");
  });
});

describe("learn degradations", () => {
  it("bitbucket signals carry replies but zero reactions", async () => {
    const fake = await startFakeBitbucket();
    try {
      fake.comments.push(
        {
          id: 1,
          content: {
            raw: renderCommentBody(
              {
                kind: "violation",
                guidelineId: "no-console",
                severity: "MAJOR",
                file: "src/app.js",
                line: 3,
                title: "Console call",
                body: "b",
              },
              "cccc55556666",
            ),
          },
          inline: { path: "src/app.js", to: 3 },
        },
        { id: 2, content: { raw: "agreed, fixing" }, parent: { id: 1 } },
      );
      const { requests, port } = capture();
      const { code } = await runLearnCli(
        {
          DELTA_PEACOCK_SCM_PROVIDER: "bitbucket",
          DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
          DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
          DELTA_PEACOCK_SCM_BASE_URL: fake.baseUrl,
          BITBUCKET_TOKEN: "test-token",
        },
        port,
      );
      expect(code).toBe(0);
      const sent = requests[0]?.user ?? "";
      expect(sent).toContain("cccc55556666");
      expect(sent).toContain("agreed, fixing");
      expect(sent).toContain('"up": 0');
    } finally {
      await fake.close();
    }
  });

  it("refuses local mode with an actionable error", async () => {
    let stderr = "";
    const code = await runCli(["learn"], {
      cwd: makeRepo(),
      env: {},
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
      modelPort: capture().port,
    });
    expect(code).toBe(1);
    expect(stderr).toContain("local mode has none");
  });

  it("an injected SCM without the capability is an actionable error", async () => {
    let stderr = "";
    const code = await runCli(["learn"], {
      cwd: makeRepo(),
      env: {
        DELTA_PEACOCK_SCM_PROVIDER: "github",
        DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
        DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
        GITHUB_TOKEN: "test-token",
      },
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
      modelPort: capture().port,
      scmPort: {
        listInlineComments: () => Promise.resolve([]),
        createInlineComment: () => Promise.resolve(),
        updateComment: () => Promise.resolve(),
        deleteComment: () => Promise.resolve(),
        listSummaryComments: () => Promise.resolve([]),
        createSummaryComment: () => Promise.resolve(),
        updateSummaryComment: () => Promise.resolve(),
        postStatus: () => Promise.resolve(),
      },
    });
    expect(code).toBe(1);
    expect(stderr).toContain("cannot read comment signals");
  });
});
