import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SEMGREP_PIN, semgrepRunner } from "../src/review/semgrep/run.js";

const RESULT = {
  version: SEMGREP_PIN,
  results: [
    {
      check_id: "logger-assigned-once.chained",
      path: "cartridges/gift.js",
      start: { line: 2, col: 1 },
      end: { line: 3, col: 9 },
      extra: { message: "m" },
    },
  ],
  errors: [{ level: "warn", message: "Syntax error at line 1\nmore", path: "src/odd.js" }],
};

/** A stand in for the semgrep CLI: a node script that records its call, then does what the body says. */
function fakeSemgrep(body: string): { command: string; record: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-semgrep-"));
  const record = path.join(dir, "call.json");
  const command = path.join(dir, "semgrep");
  writeFileSync(
    command,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const config = args[args.indexOf("--config") + 1];
const targets = args.filter((arg) => arg.startsWith("cartridges/") || arg.startsWith("src/"));
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  args,
  config: fs.readFileSync(config, "utf8"),
  targets: Object.fromEntries(targets.map((file) => [file, fs.readFileSync(file, "utf8")])),
  metrics: process.env.SEMGREP_SEND_METRICS,
}));
${body}
`,
  );
  chmodSync(command, 0o755);
  return { command, record };
}

const FILES = new Map([
  ["cartridges/gift.js", "a\nchained();\n"],
  ["src/app.js", "x\n"],
]);

const call = (record: string) =>
  JSON.parse(readFileSync(record, "utf8")) as {
    args: string[];
    config: string;
    targets: Record<string, string>;
    metrics: string;
  };

describe("semgrepRunner", () => {
  it("scans copies of the changed files offline and reads the hits and warnings", async () => {
    const fake = fakeSemgrep(`process.stdout.write(${JSON.stringify(JSON.stringify(RESULT))});`);
    const run = await semgrepRunner({ command: fake.command, timeoutMs: 20_000 })(
      "rules: []\n",
      FILES,
    );
    expect(run).toEqual({
      ok: true,
      version: SEMGREP_PIN,
      hits: [
        {
          ruleId: "logger-assigned-once.chained",
          path: "cartridges/gift.js",
          startLine: 2,
          endLine: 3,
        },
      ],
      warnings: ["src/odd.js: Syntax error at line 1"],
    });
    const seen = call(fake.record);
    expect(seen.config).toBe("rules: []\n");
    expect(seen.targets).toEqual(Object.fromEntries(FILES));
    expect(seen.args.slice(0, 2)).toEqual(["scan", "--experimental"]);
    expect(seen.args).toEqual(
      expect.arrayContaining(["--json", "--metrics", "off", "--disable-version-check"]),
    );
    expect(seen.metrics).toBe("off");
    const config = seen.args[seen.args.indexOf("--config") + 1] ?? "";
    expect(existsSync(config)).toBe(false);
  });

  it("names a warning with no path by its message alone", async () => {
    const output = { version: SEMGREP_PIN, results: [], errors: [{ message: "rule note" }] };
    const fake = fakeSemgrep(`process.stdout.write(${JSON.stringify(JSON.stringify(output))});`);
    const run = await semgrepRunner({ command: fake.command, timeoutMs: 20_000 })("", FILES);
    expect(run).toMatchObject({ ok: true, warnings: ["rule note"] });
  });

  const failures: { why: string; body: string; says: string; timeoutMs?: number }[] = [
    {
      why: "a version other than the pin",
      body: `process.stdout.write(JSON.stringify({ version: "0.1.0", results: [], errors: [] }));`,
      says: `semgrep 0.1.0 ran where the reviewer pins ${SEMGREP_PIN}`,
    },
    {
      why: "a non zero exit",
      body: `process.stderr.write("first\\nunable to find a config\\n"); process.exit(7);`,
      says: "semgrep exited with code 7: unable to find a config",
    },
    {
      why: "a non zero exit with nothing on stderr",
      body: `process.exit(2);`,
      says: "semgrep exited with code 2",
    },
    {
      why: "output that is no JSON",
      body: `process.stdout.write("oops");`,
      says: "semgrep output is unreadable",
    },
    {
      why: "JSON with no results",
      body: `process.stdout.write(JSON.stringify({ version: "${SEMGREP_PIN}" }));`,
      says: "semgrep output is unreadable",
    },
    {
      why: "a run past the timeout",
      body: `setTimeout(() => undefined, 30000);`,
      says: "semgrep timed out after 0.5s",
      timeoutMs: 500,
    },
  ];
  for (const row of failures) {
    it(`fails with a reason on ${row.why}`, async () => {
      const fake = fakeSemgrep(row.body);
      const run = await semgrepRunner({
        command: fake.command,
        timeoutMs: row.timeoutMs ?? 20_000,
      })("", FILES);
      expect(run).toEqual({ ok: false, reason: row.says });
    });
  }

  it("reads a run that lists no errors", async () => {
    const output = { version: SEMGREP_PIN, results: [] };
    const fake = fakeSemgrep(`process.stdout.write(${JSON.stringify(JSON.stringify(output))});`);
    const run = await semgrepRunner({ command: fake.command, timeoutMs: 20_000 })("", FILES);
    expect(run).toEqual({ ok: true, version: SEMGREP_PIN, hits: [], warnings: [] });
  });

  it("fails with the reason when the command cannot start", async () => {
    const fake = fakeSemgrep("");
    chmodSync(fake.command, 0o644);
    const run = await semgrepRunner({ command: fake.command, timeoutMs: 1000 })("", FILES);
    expect(run).toMatchObject({
      ok: false,
      reason: expect.stringContaining(`${fake.command} could not start: `) as string,
    });
  });

  it("fails with the install hint when the command is not there", async () => {
    const run = await semgrepRunner({ command: "/nowhere/osemgrep", timeoutMs: 1000 })("", FILES);
    expect(run).toEqual({
      ok: false,
      reason: `/nowhere/osemgrep not found; install the pinned semgrep ${SEMGREP_PIN} with node scripts/semgrep-install.mjs`,
    });
  });
});
