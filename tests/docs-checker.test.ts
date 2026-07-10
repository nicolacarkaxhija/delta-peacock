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
    const failure = error as { status: number | null; stdout: string; stderr: string };
    return { status: failure.status ?? -1, output: `${failure.stdout}${failure.stderr}` };
  }
}

describe("docs integrity checker", () => {
  it.each([
    { fixture: "valid", accepts: "a tree where every doc is indexed and every link resolves" },
    { fixture: "code-fence", accepts: "link shapes inside fenced blocks and inline code" },
  ])("passes $accepts", ({ fixture }) => {
    const { status } = runChecker(fixture);
    expect(status).toBe(0);
  });

  it.each([
    {
      fixture: "orphan",
      rejects: "a doc its registry does not reference",
      needles: ["orphan", "stray.md"],
    },
    {
      fixture: "broken-link",
      rejects: "a relative link pointing at a missing file",
      needles: ["broken link", "missing.md"],
    },
    {
      fixture: "duplicate-entry",
      rejects: "a doc claimed by more than one registry entry",
      needles: ["duplicate", "doc-a.md"],
    },
    {
      fixture: "missing-index",
      rejects: "a docs directory holding files but no registry",
      needles: ["INDEX.md"],
    },
  ])("fails $rejects", ({ fixture, needles }) => {
    const { status, output } = runChecker(fixture);
    expect(status).toBe(1);
    for (const needle of needles) {
      expect(output).toContain(needle);
    }
  });
});
