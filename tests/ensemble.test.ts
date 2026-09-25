import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import type { ModelRef } from "../src/model/build.js";
import type { ModelPort } from "../src/model/port.js";
import type { ReviewReport } from "../src/review/report.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const GUIDELINE = "---\nid: no-console\nseverity: MAJOR\n---\n# No console\n\nUse the logger.\n";

function makeScenario(): string {
  const repo = makeRepo();
  write(repo, "guidelines/no-console.md", GUIDELINE);
  commitAll(repo, "rules");
  git(repo, "checkout", "-q", "-b", "feature");
  write(repo, "src/app.js", "console.log('a');\nconsole.log('b');\n");
  commitAll(repo, "change");
  return repo;
}

function findingAt(line: number, title: string): Record<string, unknown> {
  return {
    guidelineId: "no-console",
    file: "src/app.js",
    line,
    title,
    body: "b",
    guidelineQuote: "Use the logger.",
  };
}

const MEMBERS = JSON.stringify([
  { provider: "anthropic", id: "member-a" },
  { provider: "openrouter", id: "member-b" },
]);

interface ScriptedMember {
  text?: string;
  fail?: string;
  delayMs?: number;
}

function portsFor(
  script: Record<string, ScriptedMember>,
  log: string[] = [],
): (member: ModelRef) => ModelPort {
  return (member) => ({
    async complete() {
      const entry = script[member.id];
      log.push(`start:${member.id}`);
      if (entry?.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, entry.delayMs));
      }
      log.push(`end:${member.id}`);
      if (entry?.fail !== undefined) throw new Error(entry.fail);
      return {
        text: entry?.text ?? '{"findings": []}',
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  });
}

async function reviewEnsemble(
  repo: string,
  env: Record<string, string>,
  modelPortFor: (member: ModelRef) => ModelPort,
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["review", ...args], {
    cwd: repo,
    env: {
      DELTA_PEACOCK_ENSEMBLE_ENABLED: "true",
      DELTA_PEACOCK_ENSEMBLE_MEMBERS: MEMBERS,
      ...env,
    },
    out: (text) => {
      stdout += text;
    },
    err: (text) => {
      stderr += text;
    },
    modelPortFor,
  });
  return { code, stdout, stderr };
}

describe("ensemble configuration", () => {
  it("requires members once enabled and a judge in judge mode", async () => {
    const repo = makeScenario();
    let stderr = "";
    const code = await runCli(["review"], {
      cwd: repo,
      env: { DELTA_PEACOCK_ENSEMBLE_ENABLED: "true", DELTA_PEACOCK_ENSEMBLE_MODE: "judge" },
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
    });
    expect(code).toBe(1);
    expect(stderr).toContain("ensemble.members");
    expect(stderr).toContain("ensemble.judge");
  });
});

describe("union mode", () => {
  it("merges member findings with fingerprint dedup and attributes usage", async () => {
    const repo = makeScenario();
    const shared = findingAt(1, "Console call");
    const script = {
      "member-a": { text: JSON.stringify({ findings: [shared, findingAt(2, "Second call")] }) },
      "member-b": { text: JSON.stringify({ findings: [shared] }) },
    };
    const { code, stdout } = await reviewEnsemble(repo, {}, portsFor(script), "--report", "e.json");
    expect(code).toBe(0);
    expect(stdout).toContain("2 finding(s)");
    const report = JSON.parse(readFileSync(path.join(repo, "e.json"), "utf8")) as ReviewReport;
    expect(report.findings).toHaveLength(2);
    expect(report.usage).toMatchObject({ inputTokens: 20, outputTokens: 10 });
    expect(report.ensemble?.mode).toBe("union");
    expect(report.ensemble?.members).toHaveLength(2);
    expect(report.ensemble?.members.every((member) => member.ok)).toBe(true);
  });

  it("runs the members concurrently", async () => {
    const repo = makeScenario();
    const log: string[] = [];
    const script = {
      "member-a": { delayMs: 60 },
      "member-b": { delayMs: 60 },
    };
    await reviewEnsemble(repo, {}, portsFor(script, log));
    expect(log.slice(0, 2).sort()).toEqual(["start:member-a", "start:member-b"]);
  });

  it("tolerates one failing member with a warning", async () => {
    const repo = makeScenario();
    const script = {
      "member-a": { text: JSON.stringify({ findings: [findingAt(1, "Console call")] }) },
      "member-b": { fail: "socket hang up" },
    };
    const { code, stdout, stderr } = await reviewEnsemble(
      repo,
      {},
      portsFor(script),
      "--report",
      "p.json",
    );
    expect(code).toBe(0);
    expect(stdout).toContain("1 finding(s)");
    expect(stderr).toContain("member-b failed: socket hang up");
    const report = JSON.parse(readFileSync(path.join(repo, "p.json"), "utf8")) as ReviewReport;
    expect(report.ensemble?.members.find((member) => member.id === "member-b")?.ok).toBe(false);
  });

  it("treats an unparseable member answer as a member failure", async () => {
    const repo = makeScenario();
    const script = {
      "member-a": { text: JSON.stringify({ findings: [findingAt(1, "Console call")] }) },
      "member-b": { text: "I only speak prose." },
    };
    const { code, stdout, stderr } = await reviewEnsemble(repo, {}, portsFor(script));
    expect(code).toBe(0);
    expect(stdout).toContain("1 finding(s)");
    expect(stderr).toContain("member-b answered unusably");
  });

  it("stops with a tool error when every member fails", async () => {
    const repo = makeScenario();
    const script = {
      "member-a": { fail: "down" },
      "member-b": { fail: "also down" },
    };
    const { code, stderr } = await reviewEnsemble(repo, {}, portsFor(script));
    expect(code).toBe(1);
    expect(stderr).toContain("every ensemble member failed");
  });
});

describe("without injected ports", () => {
  it("builds real member adapters and surfaces their credential demands", async () => {
    const repo = makeScenario();
    let stderr = "";
    const code = await runCli(["review"], {
      cwd: repo,
      env: {
        DELTA_PEACOCK_ENSEMBLE_ENABLED: "true",
        DELTA_PEACOCK_ENSEMBLE_MEMBERS: MEMBERS,
      },
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
    });
    expect(code).toBe(1);
    expect(stderr).toContain("every ensemble member failed");
    expect(stderr).toContain("ANTHROPIC_API_KEY");
    expect(stderr).toContain("OPENROUTER_API_KEY");
  });
});

describe("judge mode", () => {
  const JUDGE_ENV = {
    DELTA_PEACOCK_ENSEMBLE_MODE: "judge",
    DELTA_PEACOCK_ENSEMBLE_JUDGE: JSON.stringify({ provider: "anthropic", id: "the-judge" }),
  };

  it("keeps only what the judge confirms", async () => {
    const repo = makeScenario();
    const keep = findingAt(1, "Real problem");
    const noisy = findingAt(2, "False positive");
    const judgeCalls: string[] = [];
    const script: Record<string, ScriptedMember> = {
      "member-a": { text: JSON.stringify({ findings: [keep, noisy] }) },
      "member-b": { text: JSON.stringify({ findings: [noisy] }) },
    };
    const ports = (member: ModelRef): ModelPort => ({
      complete(request) {
        if (member.id === "the-judge") {
          judgeCalls.push(request.user);
          return Promise.resolve({ text: JSON.stringify({ findings: [keep] }) });
        }
        return Promise.resolve({ text: script[member.id]?.text ?? '{"findings": []}' });
      },
    });
    const { code, stdout } = await reviewEnsemble(repo, JUDGE_ENV, ports, "--report", "j.json");
    expect(code).toBe(0);
    expect(stdout).toContain("1 finding(s)");
    expect(stdout).toContain("Real problem");
    expect(stdout).not.toContain("False positive");
    expect(judgeCalls).toHaveLength(1);
    expect(judgeCalls[0]).toContain("Candidate findings");
    const report = JSON.parse(readFileSync(path.join(repo, "j.json"), "utf8")) as ReviewReport;
    expect(report.ensemble?.members.some((member) => member.id === "the-judge")).toBe(true);
    // the judge's own reply still carries a verified guidelineQuote, not dropped along the way
    expect(report.findings[0]).toMatchObject({ guidelineQuote: "Use the logger." });
  });

  it("falls back to the union when the judge fails", async () => {
    const repo = makeScenario();
    const ports = (member: ModelRef): ModelPort => ({
      complete() {
        if (member.id === "the-judge") return Promise.reject(new Error("judge crashed"));
        return Promise.resolve({
          text: JSON.stringify({ findings: [findingAt(1, "Kept by union")] }),
        });
      },
    });
    const { code, stdout, stderr } = await reviewEnsemble(repo, JUDGE_ENV, ports);
    expect(code).toBe(0);
    expect(stdout).toContain("Kept by union");
    expect(stderr).toContain("falling back to the union");
  });

  it("skips the judge call when there are no candidates", async () => {
    const repo = makeScenario();
    let judgeInvoked = false;
    const ports = (member: ModelRef): ModelPort => ({
      complete() {
        if (member.id === "the-judge") judgeInvoked = true;
        return Promise.resolve({ text: '{"findings": []}' });
      },
    });
    const { code, stdout, stderr } = await reviewEnsemble(repo, JUDGE_ENV, ports);
    expect(code).toBe(0);
    expect(stdout).toContain("No findings.");
    expect(stderr).toContain("judge call was skipped");
    expect(judgeInvoked).toBe(false);
  });
});
