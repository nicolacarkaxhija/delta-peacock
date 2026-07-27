import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import type { ModelPort } from "../src/model/port.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const GUIDELINE = "---\nid: no-console\nseverity: MAJOR\n---\n# No console\n\nUse the logger.\n";

function findingReply(entries: { line: number; suggestion?: string }[]): string {
  return JSON.stringify({
    findings: entries.map((entry, index) => ({
      guidelineId: "no-console",
      file: "src/app.js",
      line: entry.line,
      title: `Finding ${String(index + 1)}`,
      body: "b",
      ...(entry.suggestion !== undefined ? { suggestion: entry.suggestion } : {}),
    })),
  });
}

function model(text: string): ModelPort {
  return { complete: () => Promise.resolve({ text }) };
}

/** A repo with a reviewed change and a report holding suggestions. */
async function reviewedRepo(
  fileContent: string,
  reply: string,
  eol: "\n" | "\r\n" = "\n",
  extraGuidelines: Record<string, string> = {},
): Promise<{ repo: string; reportPath: string }> {
  const repo = makeRepo();
  write(repo, "guidelines/no-console.md", GUIDELINE);
  for (const [relPath, content] of Object.entries(extraGuidelines)) write(repo, relPath, content);
  commitAll(repo, "rules");
  git(repo, "checkout", "-q", "-b", "feature");
  const full = path.join(repo, "src/app.js");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, fileContent.replaceAll("\n", eol));
  commitAll(repo, "change");
  const reportPath = path.join(repo, "report.json");
  const code = await runCli(["review", "--report", reportPath], {
    cwd: repo,
    env: {},
    out: () => undefined,
    err: () => undefined,
    modelPort: model(reply),
  });
  expect(code).toBe(0);
  return { repo, reportPath };
}

function runFixCli(repo: string, args: string[] = []): Promise<{ code: number; stdout: string }> {
  let stdout = "";
  return runCli(["fix", "--report", "report.json", ...args], {
    cwd: repo,
    env: {},
    out: (text) => {
      stdout += text;
    },
    err: (text) => {
      stdout += text;
    },
    modelPort: model("{}"),
  }).then((code) => ({ code, stdout }));
}

describe("fix applies suggestions", () => {
  it("replaces the flagged line in place", async () => {
    const { repo } = await reviewedRepo(
      "const a = 1;\nconsole.log('x');\nconst b = 2;\n",
      findingReply([{ line: 2, suggestion: "logger.info('x');" }]),
    );
    const { code, stdout } = await runFixCli(repo);
    expect(code).toBe(0);
    expect(stdout).toContain("applied  src/app.js:2");
    const content = readFileSync(path.join(repo, "src/app.js"), "utf8");
    expect(content).toBe("const a = 1;\nlogger.info('x');\nconst b = 2;\n");
  });

  it("expands a multi-line suggestion and applies bottom-up", async () => {
    const { repo } = await reviewedRepo(
      "console.log('a');\nmiddle();\nconsole.log('b');\n",
      findingReply([
        { line: 1, suggestion: "if (debug) {\n  logger.info('a');\n}" },
        { line: 3, suggestion: "logger.info('b');" },
      ]),
    );
    const { code } = await runFixCli(repo);
    expect(code).toBe(0);
    expect(readFileSync(path.join(repo, "src/app.js"), "utf8")).toBe(
      "if (debug) {\n  logger.info('a');\n}\nmiddle();\nlogger.info('b');\n",
    );
  });

  it("preserves CRLF endings", async () => {
    const { repo } = await reviewedRepo(
      "console.log('x');\nrest();\n",
      findingReply([{ line: 1, suggestion: "logger.info('x');" }]),
      "\r\n",
    );
    const { code } = await runFixCli(repo);
    expect(code).toBe(0);
    expect(readFileSync(path.join(repo, "src/app.js"), "utf8")).toBe(
      "logger.info('x');\r\nrest();\r\n",
    );
  });

  it("skips a drifted line with exit 3 and applies the rest", async () => {
    const { repo } = await reviewedRepo(
      "console.log('a');\nconsole.log('b');\n",
      findingReply([
        { line: 1, suggestion: "logger.info('a');" },
        { line: 2, suggestion: "logger.info('b');" },
      ]),
    );
    // drift line 2 after the review, then commit so the tree is clean
    const full = path.join(repo, "src/app.js");
    writeFileSync(full, "console.log('a');\nsomethingElse();\n");
    commitAll(repo, "drift");
    const { code, stdout } = await runFixCli(repo);
    expect(code).toBe(3);
    expect(stdout).toContain("applied  src/app.js:1");
    expect(stdout).toContain("changed since the review");
    expect(readFileSync(full, "utf8")).toContain("logger.info('a');");
    expect(readFileSync(full, "utf8")).toContain("somethingElse();");
  });

  it("refuses a dirty file without --force and edits it with", async () => {
    const { repo } = await reviewedRepo(
      "console.log('x');\n",
      findingReply([{ line: 1, suggestion: "logger.info('x');" }]),
    );
    const full = path.join(repo, "src/app.js");
    writeFileSync(full, "console.log('x');\nuncommitted();\n"); // dirty, line 1 intact
    const refused = await runFixCli(repo);
    expect(refused.code).toBe(3);
    expect(refused.stdout).toContain("uncommitted changes");
    const forced = await runFixCli(repo, ["--force"]);
    expect(forced.code).toBe(0);
    expect(readFileSync(full, "utf8")).toContain("logger.info('x');");
  });

  it("skips overlapping suggestions on the same line", async () => {
    // two distinct guidelines legitimately flag the same line with conflicting
    // fixes; same file + line but a different guidelineId is a different
    // finding, so both survive to the report for the fix command's own guard
    const { repo } = await reviewedRepo(
      "console.log('x');\n",
      JSON.stringify({
        findings: [
          {
            guidelineId: "no-console",
            file: "src/app.js",
            line: 1,
            title: "One",
            body: "b",
            suggestion: "logger.info('x');",
          },
          {
            guidelineId: "no-var",
            file: "src/app.js",
            line: 1,
            title: "Two",
            body: "b",
            suggestion: "logger.warn('x');",
          },
        ],
      }),
      "\n",
      {
        "guidelines/no-var.md":
          "---\nid: no-var\nseverity: MAJOR\n---\n# No var\n\nUse const/let.\n",
      },
    );
    const { code, stdout } = await runFixCli(repo);
    expect(code).toBe(3);
    expect(stdout).toContain("another suggestion already edits that line");
    expect(readFileSync(path.join(repo, "src/app.js"), "utf8")).toBe("logger.info('x');\n");
  });
});

describe("fix as a patch", () => {
  it("writes a unified diff that git apply accepts, touching nothing", async () => {
    const { repo } = await reviewedRepo(
      "const a = 1;\nconsole.log('x');\nconst b = 2;\n",
      findingReply([{ line: 2, suggestion: "logger.info('x');" }]),
    );
    const before = readFileSync(path.join(repo, "src/app.js"), "utf8");
    const { code, stdout } = await runFixCli(repo, ["--patch-file", "fixes.patch"]);
    expect(code).toBe(0);
    expect(stdout).toContain("fixes.patch");
    expect(readFileSync(path.join(repo, "src/app.js"), "utf8")).toBe(before); // untouched
    git(repo, "config", "core.autocrlf", "false");
    git(repo, "apply", "fixes.patch");
    expect(readFileSync(path.join(repo, "src/app.js"), "utf8")).toBe(
      "const a = 1;\nlogger.info('x');\nconst b = 2;\n",
    );
  });

  it("stacks several hunks in one file with correct offsets", async () => {
    const { repo } = await reviewedRepo(
      "console.log('a');\nkeep();\nconsole.log('b');\nend();\n",
      findingReply([
        { line: 1, suggestion: "logger.info('a');\nlogger.debug('a2');" },
        { line: 3, suggestion: "logger.info('b');" },
      ]),
    );
    const { code } = await runFixCli(repo, ["--patch-file", "fixes.patch"]);
    expect(code).toBe(0);
    git(repo, "config", "core.autocrlf", "false");
    git(repo, "apply", "fixes.patch");
    expect(readFileSync(path.join(repo, "src/app.js"), "utf8")).toBe(
      "logger.info('a');\nlogger.debug('a2');\nkeep();\nlogger.info('b');\nend();\n",
    );
  });
});

describe("fix edge paths from a synthetic report", () => {
  function syntheticReport(repo: string, findings: Record<string, unknown>[]): void {
    writeFileSync(path.join(repo, "report.json"), JSON.stringify({ findings }));
  }

  function repoWithFile(content: string): string {
    const repo = makeRepo();
    write(repo, "src/app.js", content);
    commitAll(repo, "base");
    return repo;
  }

  it("skips a line beyond the end of the file and one without an anchor", async () => {
    const repo = repoWithFile("only();\n");
    syntheticReport(repo, [
      {
        kind: "violation",
        guidelineId: "g",
        severity: "MAJOR",
        file: "src/app.js",
        line: 99,
        title: "gone",
        body: "b",
        fingerprint: "f1",
        suggestion: "never();",
        lineText: "whatever",
      },
      {
        kind: "violation",
        guidelineId: "g",
        severity: "MAJOR",
        file: "src/app.js",
        line: 1,
        title: "anchorless",
        body: "b",
        fingerprint: "f2",
        suggestion: "still();",
      },
    ]);
    const { code, stdout } = await runFixCli(repo);
    expect(code).toBe(3);
    expect(stdout).toContain("no longer has that line");
    expect(stdout).toContain("no anchor text");
    expect(readFileSync(path.join(repo, "src/app.js"), "utf8")).toBe("only();\n");
  });

  it("patches the last line of a file (no trailing context)", async () => {
    const repo = repoWithFile("first();\nconsole.log('x');\n");
    syntheticReport(repo, [
      {
        kind: "violation",
        guidelineId: "g",
        severity: "MAJOR",
        file: "src/app.js",
        line: 2,
        title: "last",
        body: "b",
        fingerprint: "f",
        suggestion: "logger.info('x');",
        lineText: "console.log('x');",
      },
    ]);
    const { code } = await runFixCli(repo, ["--patch-file", "fixes.patch"]);
    expect(code).toBe(0);
    git(repo, "config", "core.autocrlf", "false");
    git(repo, "apply", "fixes.patch");
    expect(readFileSync(path.join(repo, "src/app.js"), "utf8")).toBe(
      "first();\nlogger.info('x');\n",
    );
  });

  it("generates a patch even from a dirty tree", async () => {
    const repo = repoWithFile("console.log('x');\n");
    writeFileSync(path.join(repo, "src/app.js"), "console.log('x');\nextra();\n"); // dirty
    syntheticReport(repo, [
      {
        kind: "violation",
        guidelineId: "g",
        severity: "MAJOR",
        file: "src/app.js",
        line: 1,
        title: "t",
        body: "b",
        fingerprint: "f",
        suggestion: "logger.info('x');",
        lineText: "console.log('x');",
      },
    ]);
    const { code } = await runFixCli(repo, ["--patch-file", "fixes.patch"]);
    expect(code).toBe(0); // a patch never clobbers, so dirty is fine
  });

  it("preserves a missing trailing newline", async () => {
    const repo = repoWithFile("console.log('x');"); // no trailing newline
    syntheticReport(repo, [
      {
        kind: "violation",
        guidelineId: "g",
        severity: "MAJOR",
        file: "src/app.js",
        line: 1,
        title: "t",
        body: "b",
        fingerprint: "f",
        suggestion: "logger.info('x');",
        lineText: "console.log('x');",
      },
    ]);
    const { code } = await runFixCli(repo);
    expect(code).toBe(0);
    expect(readFileSync(path.join(repo, "src/app.js"), "utf8")).toBe("logger.info('x');");
  });
});

describe("fix edge paths", () => {
  it("says so when the report holds no suggestions", async () => {
    const { repo } = await reviewedRepo(
      "console.log('x');\n",
      findingReply([{ line: 1 }]), // finding without a suggestion
    );
    const { code, stdout } = await runFixCli(repo);
    expect(code).toBe(0);
    expect(stdout).toContain("nothing to fix");
  });

  it("needs an existing report", async () => {
    const repo = makeRepo();
    let stderr = "";
    const code = await runCli(["fix", "--report", "missing.json"], {
      cwd: repo,
      env: {},
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
      modelPort: model("{}"),
    });
    expect(code).toBe(1);
    expect(stderr).toContain("no report at");
  });

  it("needs a report path from somewhere", async () => {
    const repo = makeRepo();
    let stderr = "";
    const code = await runCli(["fix"], {
      cwd: repo,
      env: {},
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
      modelPort: model("{}"),
    });
    expect(code).toBe(1);
    expect(stderr).toContain("--report");
  });

  it("reports a vanished file as skipped", async () => {
    const { repo } = await reviewedRepo(
      "console.log('x');\n",
      findingReply([{ line: 1, suggestion: "logger.info('x');" }]),
    );
    const { rmSync } = await import("node:fs");
    rmSync(path.join(repo, "src/app.js"));
    const { code, stdout } = await runFixCli(repo);
    expect(code).toBe(3);
    expect(stdout).toContain("the file is gone");
  });
});
