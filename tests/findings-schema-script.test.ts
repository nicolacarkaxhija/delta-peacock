import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "scripts/findings-schema.mjs");
const VENDORED = path.join(ROOT, "schema/finding.schema.json");

function run(args: string[], input?: string): { code: number | null; out: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    ...(input !== undefined ? { input } : {}),
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), "findings-schema-"));
}

/** A vendored copy in a scratch folder, so a refresh never touches the repository's own. */
function vendoredCopy(): string {
  const file = path.join(scratch(), "finding.schema.json");
  copyFileSync(VENDORED, file);
  return file;
}

function drifted(): string {
  const schema = JSON.parse(readFileSync(VENDORED, "utf8")) as { properties: object };
  const file = path.join(scratch(), "engine.json");
  writeFileSync(file, JSON.stringify({ ...schema, properties: { ...schema.properties, x: {} } }));
  return file;
}

const VALID = JSON.stringify({
  schema: "findings-1",
  findings: [
    {
      producer: "reviewer",
      rule: "no-console",
      severity: "warning",
      file: "src/app.js",
      range: { startLine: 2 },
      message: "m",
    },
  ],
});

describe("findings-schema check", () => {
  it("passes when the engine's schema says what the vendored copy says, in any layout, from a file or stdin", () => {
    const compact = path.join(scratch(), "engine.json");
    writeFileSync(compact, JSON.stringify(JSON.parse(readFileSync(VENDORED, "utf8"))));
    expect(run(["check", compact])).toEqual({ code: 0, out: "findings schema: in step\n" });
    expect(run(["check", "-"], readFileSync(VENDORED, "utf8")).code).toBe(0);
  });

  it("fails on a drifted engine schema and names the refresh command", () => {
    const result = run(["check", drifted(), "--vendored", vendoredCopy()]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("findings schema: the vendored copy");
    expect(result.out).toContain("node scripts/findings-schema.mjs refresh");
  });
});

describe("findings-schema refresh", () => {
  it("writes the engine's schema over the vendored copy, after which the check passes", () => {
    const engine = drifted();
    const vendored = vendoredCopy();
    expect(run(["refresh", engine, "--vendored", vendored]).code).toBe(0);
    expect(JSON.parse(readFileSync(vendored, "utf8"))).toEqual(
      JSON.parse(readFileSync(engine, "utf8")),
    );
    expect(run(["check", engine, "--vendored", vendored]).code).toBe(0);
  });
});

describe("findings-schema validate", () => {
  it("passes a findings file the schema takes and names the place of one it refuses", () => {
    const dir = scratch();
    writeFileSync(path.join(dir, "good.json"), VALID);
    writeFileSync(path.join(dir, "bad.json"), VALID.replace('"warning"', '"MAJOR"'));
    expect(run(["validate", path.join(dir, "good.json")])).toEqual({
      code: 0,
      out: `${path.join(dir, "good.json")}: valid\n`,
    });
    const bad = run(["validate", path.join(dir, "bad.json")]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("/findings/0/severity");
  });

  it("refuses an unknown command and a missing source", () => {
    expect(run(["publish"]).code).toBe(2);
    expect(run(["check"]).out).toContain(
      "usage: node scripts/findings-schema.mjs check|refresh|validate",
    );
  });
});
