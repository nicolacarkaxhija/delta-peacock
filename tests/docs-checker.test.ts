import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/check-docs.mjs", import.meta.url));

function runChecker(fixture: string): { status: number; output: string } {
  const root = fileURLToPath(new URL(`./fixtures/docs-checker/${fixture}`, import.meta.url));
  try {
    const output = execFileSync(process.execPath, [script, root], { encoding: "utf8" });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    return { status: failure.status, output: `${failure.stdout}${failure.stderr}` };
  }
}

describe("docs integrity checker", () => {
  it("passes a tree where every doc is indexed and every link resolves", () => {
    const { status } = runChecker("valid");
    expect(status).toBe(0);
  });

  it("fails on a doc its registry does not reference", () => {
    const { status, output } = runChecker("orphan");
    expect(status).toBe(1);
    expect(output).toContain("orphan");
    expect(output).toContain("stray.md");
  });

  it("fails on a relative link pointing at a missing file", () => {
    const { status, output } = runChecker("broken-link");
    expect(status).toBe(1);
    expect(output).toContain("broken link");
    expect(output).toContain("missing.md");
  });

  it("fails on a docs directory holding files but no registry", () => {
    const { status, output } = runChecker("missing-index");
    expect(status).toBe(1);
    expect(output).toContain("INDEX.md");
  });
});
