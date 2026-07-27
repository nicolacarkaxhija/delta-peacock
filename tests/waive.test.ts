import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runWaive } from "../src/commands/waive.js";
import { makeRepo, write } from "./helpers/git.js";
import { testDeps as deps } from "./helpers/deps.js";

function lineOf(repo: string, file: string, index: number): string {
  return readFileSync(path.join(repo, file), "utf8").split("\n")[index] ?? "";
}

describe("runWaive", () => {
  it("appends a trailing waiver directive to the target line of a JS file", () => {
    const repo = makeRepo();
    write(repo, "src/app.js", "function f() {\n  console.log(x);\n  return x;\n}\n");
    const code = runWaive(deps(repo), {
      guidelineId: "no-console",
      file: "src/app.js",
      line: 2,
      reason: "legacy shim",
    });
    expect(code).toBe(0);
    expect(lineOf(repo, "src/app.js", 1)).toBe(
      "  console.log(x); // delta-peacock:allow no-console — legacy shim",
    );
  });

  it("uses a # comment leader for a Python file and appends until=", () => {
    const repo = makeRepo();
    write(repo, "s.py", "print(x)\n");
    runWaive(deps(repo), {
      guidelineId: "no-print",
      file: "s.py",
      line: 1,
      reason: "debug",
      until: "2027-01-01",
    });
    expect(lineOf(repo, "s.py", 0)).toBe(
      "print(x) # delta-peacock:allow no-print — debug until=2027-01-01",
    );
  });

  it("produces a directive that the waiver parser accepts and matches", async () => {
    const { parseWaivers, findWaiver } = await import("../src/review/waiver.js");
    const repo = makeRepo();
    write(repo, "src/app.js", "console.log(x);\n");
    runWaive(deps(repo), {
      guidelineId: "no-console",
      file: "src/app.js",
      line: 1,
      reason: "shim",
    });
    const text = lineOf(repo, "src/app.js", 0);
    const { waivers } = parseWaivers(new Map([["src/app.js", new Map([[1, text]])]]));
    expect(
      findWaiver({ guidelineId: "no-console", file: "src/app.js", line: 1 }, waivers)?.reason,
    ).toBe("shim");
  });

  it.each([
    {
      name: "an empty reason",
      file: "src/app.js",
      line: 1,
      reason: "  ",
      seed: true,
      msg: "needs a reason",
    },
    {
      name: "a missing file",
      file: "nope.js",
      line: 1,
      reason: "r",
      seed: false,
      msg: "file not found",
    },
    {
      name: "a line past the end",
      file: "src/app.js",
      line: 99,
      reason: "r",
      seed: true,
      msg: "no line 99",
    },
  ])("rejects $name", ({ file, line, reason, seed, msg }) => {
    const repo = makeRepo();
    if (seed) write(repo, "src/app.js", "console.log(x);\n");
    expect(() => runWaive(deps(repo), { guidelineId: "g", file, line, reason })).toThrow(msg);
  });
});

describe("waive command", () => {
  it("parses file:line from the CLI and inserts the directive", async () => {
    const { runCli } = await import("../src/index.js");
    const repo = makeRepo();
    write(repo, "src/app.js", "console.log(x);\n");
    const code = await runCli(
      ["waive", "no-console", "src/app.js:1", "--reason", "shim"],
      deps(repo),
    );
    expect(code).toBe(0);
    expect(lineOf(repo, "src/app.js", 0)).toContain("delta-peacock:allow no-console — shim");
  });

  it("threads --until into the directive", async () => {
    const { runCli } = await import("../src/index.js");
    const repo = makeRepo();
    write(repo, "src/app.js", "console.log(x);\n");
    const code = await runCli(
      ["waive", "no-console", "src/app.js:1", "--reason", "shim", "--until", "2027-01-01"],
      deps(repo),
    );
    expect(code).toBe(0);
    expect(lineOf(repo, "src/app.js", 0)).toContain("until=2027-01-01");
  });

  it.each(["src/app.js", "src/app.js:abc", "src/app.js:0"])(
    "rejects the malformed location %s",
    async (location) => {
      const { runCli } = await import("../src/index.js");
      const repo = makeRepo();
      write(repo, "src/app.js", "console.log(x);\n");
      let err = "";
      const code = await runCli(["waive", "no-console", location, "--reason", "r"], {
        ...deps(repo),
        err: (text) => {
          err += text;
        },
      });
      expect(code).not.toBe(0);
      expect(err.toLowerCase()).toContain("file:line");
    },
  );
});
