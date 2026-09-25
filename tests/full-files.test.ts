import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { activeStrategies, buildContextProvider, resolveContext } from "../src/context/build.js";
import { createFullFilesProvider } from "../src/context/full-files.js";
import { approximateTokens } from "../src/context/port.js";
import { loadConfig } from "../src/config/loader.js";

function tree(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(path.join(tmpdir(), "dp-full-files-"));
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(root, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

const lines = (count: number, label: string): string =>
  Array.from(
    { length: count },
    (_, i) => `${label} line ${String(i + 1)} with some padding text`,
  ).join("\n");

describe("full_files provider", () => {
  it("injects every changed text file whole under its path", () => {
    const cwd = tree({ "pages/pdp.ts": "export const a = 1;\n", "tests/x.spec.ts": "test();\n" });
    const text = createFullFilesProvider({ maxTokens: 4000 }).systemContext({
      cwd,
      diff: "",
      changedFiles: ["pages/pdp.ts", "tests/x.spec.ts"],
    });
    expect(text).toContain("=== pages/pdp.ts ===\nexport const a = 1;");
    expect(text).toContain("=== tests/x.spec.ts ===\ntest();");
    expect(text).not.toContain("truncated");
  });

  it("skips deleted, binary, directory and out-of-tree paths", () => {
    const cwd = tree({ "img.png": Buffer.from([137, 80, 0, 1]), "dir/keep.ts": "ok\n" });
    const text = createFullFilesProvider({ maxTokens: 4000 }).systemContext({
      cwd,
      diff: "",
      changedFiles: ["gone.ts", "img.png", "dir", "../outside.ts", "dir/keep.ts"],
    });
    expect(text).toContain("=== dir/keep.ts ===");
    expect(text).not.toContain("img.png");
    expect(text).not.toContain("gone.ts");
    expect(text).not.toContain("outside");
  });

  it("returns nothing when no changed file is readable text", () => {
    const cwd = tree({});
    expect(
      createFullFilesProvider({ maxTokens: 4000 }).systemContext({
        cwd,
        diff: "",
        changedFiles: ["missing.ts"],
      }),
    ).toBe("");
  });

  it("truncates only the largest file, with a marker, and stays inside the budget", () => {
    const cwd = tree({ "small.ts": lines(5, "small"), "big.ts": lines(400, "big") });
    const text = createFullFilesProvider({ maxTokens: 1000 }).systemContext({
      cwd,
      diff: "",
      changedFiles: ["big.ts", "small.ts"],
    });
    expect(text).toContain("small line 5 with some padding text");
    expect(text).toMatch(/\[truncated: \d+ more lines not shown\]/);
    expect(text.indexOf("=== small.ts ===")).toBeLessThan(text.indexOf("=== big.ts ==="));
    expect(approximateTokens(text)).toBeLessThanOrEqual(1000);
  });

  it("names a file it has no room left for", () => {
    const cwd = tree({ "a.ts": lines(50, "a"), "b.ts": lines(50, "b") });
    const text = createFullFilesProvider({ maxTokens: 30 }).systemContext({
      cwd,
      diff: "",
      changedFiles: ["a.ts", "b.ts"],
    });
    expect(text).toContain("[truncated: 50 lines not shown]");
  });

  it("is selectable alone and composes with agentic through context.providers", async () => {
    const cwd = tree({ "a.ts": "const a = 1;\n" });
    const solo = loadConfig({ root: cwd, env: { DELTA_PEACOCK_CONTEXT_PROVIDER: "full_files" } });
    expect(activeStrategies(solo)).toEqual(["full_files"]);
    expect(buildContextProvider(solo).name).toBe("full_files");
    const layered = loadConfig({
      root: cwd,
      env: { DELTA_PEACOCK_CONTEXT_PROVIDERS: "full_files,agentic" },
    });
    expect(buildContextProvider(layered).name).toBe("full_files+agentic");
    const resolved = await resolveContext(layered, {}, { cwd, diff: "", changedFiles: ["a.ts"] });
    expect(resolved.projectContext).toContain("=== a.ts ===");
    expect(resolved.tools).toBeDefined();
  });
});
