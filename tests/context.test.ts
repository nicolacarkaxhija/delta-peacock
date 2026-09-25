import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolSet } from "ai";
import { createAgenticProvider } from "../src/context/agentic.js";
import { approximateTokens, capToTokenBudget } from "../src/context/port.js";
import { createRagProvider } from "../src/context/rag.js";
import { createRepoMapProvider } from "../src/context/repo-map.js";
import { mergeBaseDiff } from "../src/git/diff.js";
import { runCli } from "../src/index.js";
import type { ModelPort, ModelRequest } from "../src/model/port.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const GUIDELINE = "---\nid: no-console\nseverity: MAJOR\n---\n# No console\n\nUse the logger.\n";

/** A repo where a caller outside the diff depends on the changed function. */
function makeCrossFileRepo(): { repo: string; diff: string } {
  const repo = makeRepo();
  write(repo, "guidelines/no-console.md", GUIDELINE);
  write(
    repo,
    "src/callers/consumer.js",
    "const { greet } = require('../app.js');\nfunction welcome(user) {\n  return greet(user.name);\n}\nmodule.exports = { welcome };\n",
  );
  commitAll(repo, "base with a caller");
  git(repo, "checkout", "-q", "-b", "feature");
  write(
    repo,
    "src/app.js",
    "function greet(name, formal) {\n  return formal ? 'Dear ' + name : 'hi ' + name;\n}\n",
  );
  commitAll(repo, "change greet signature");
  return { repo, diff: mergeBaseDiff(repo, "main") };
}

describe("token budget", () => {
  it("caps on line boundaries", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${String(i)} padding padding`).join(
      "\n",
    );
    const capped = capToTokenBudget(text, 50);
    expect(approximateTokens(capped)).toBeLessThanOrEqual(50);
    expect(capped.endsWith("padding")).toBe(true); // whole lines only
  });

  it("leaves short text alone", () => {
    expect(capToTokenBudget("short", 100)).toBe("short");
  });
});

describe("repo_map provider", () => {
  it("surfaces callers of changed symbols and excludes changed files", () => {
    const { repo, diff } = makeCrossFileRepo();
    const map = createRepoMapProvider().systemContext({
      cwd: repo,
      diff,
      changedFiles: ["src/app.js"],
    });
    expect(map).toContain("src/callers/consumer.js");
    expect(map).toContain("welcome");
    expect(map).not.toContain("src/app.js:");
  });

  it("is deterministic for the same tree", () => {
    const { repo, diff } = makeCrossFileRepo();
    const input = { cwd: repo, diff, changedFiles: ["src/app.js"] };
    const provider = createRepoMapProvider();
    expect(provider.systemContext(input)).toBe(provider.systemContext(input));
  });

  it("skips oversized files instead of reading them", () => {
    const { repo, diff } = makeCrossFileRepo();
    write(repo, "src/huge.js", `function bulky() {}\n${"//x\n".repeat(200000)}`);
    const map = createRepoMapProvider().systemContext({
      cwd: repo,
      diff,
      changedFiles: ["src/app.js"],
    });
    expect(map).not.toContain("huge.js");
  });

  it("ranks definers above mere callers and breaks score ties by path", async () => {
    const repo = makeRepo();
    write(repo, "src/b.js", "function beta() {\n  return greet(1);\n}\n");
    write(repo, "src/a.js", "function alpha() {\n  return greet(2);\n}\n");
    write(repo, "src/c.js", "function welcome() {\n  return 3;\n}\n");
    const map = await createRepoMapProvider().systemContext({
      cwd: repo,
      diff: "+greet(welcome)\n",
      changedFiles: ["src/app.js"],
    });
    const order = ["src/c.js:", "src/a.js:", "src/b.js:"].map((header) => map.indexOf(header));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    // a caller defines none of the wanted symbols, so its own signatures stand in
    expect(map).toContain("function alpha() {");
  });

  it("returns nothing when the diff shares no symbols with the repo", () => {
    const repo = makeRepo();
    const map = createRepoMapProvider().systemContext({
      cwd: repo,
      diff: "+++ b/x.txt\n+plainwords without code identifiers\n",
      changedFiles: ["x.txt"],
    });
    expect(map).toBe("");
  });

  it("reaches the prompt through the default configuration", async () => {
    const { repo } = makeCrossFileRepo();
    const requests: ModelRequest[] = [];
    const port: ModelPort = {
      complete(request) {
        requests.push(request);
        return Promise.resolve({ text: '{"findings": []}' });
      },
    };
    const code = await runCli(["review"], {
      cwd: repo,
      env: {},
      out: () => undefined,
      err: () => undefined,
      modelPort: port,
    });
    expect(code).toBe(0);
    expect(requests[0]?.system).toContain("## Project context");
    expect(requests[0]?.system).toContain("consumer.js");
    expect(requests[0]?.tools).toBeUndefined(); // repo_map offers no tools
  });

  it("stays out of the prompt when disabled", async () => {
    const { repo } = makeCrossFileRepo();
    const requests: ModelRequest[] = [];
    const port: ModelPort = {
      complete(request) {
        requests.push(request);
        return Promise.resolve({ text: '{"findings": []}' });
      },
    };
    await runCli(["review"], {
      cwd: repo,
      env: { DELTA_PEACOCK_CONTEXT_PROVIDER: "none" },
      out: () => undefined,
      err: () => undefined,
      modelPort: port,
    });
    expect(requests[0]?.system).not.toContain("## Project context");
  });
});

describe("agentic provider", () => {
  function toolsFor(repo: string): ToolSet {
    const provider = createAgenticProvider();
    const tools = provider.tools?.({ cwd: repo, diff: "", changedFiles: [] });
    if (tools === undefined) throw new Error("agentic must offer tools");
    return tools;
  }

  async function call(tools: ToolSet, name: string, args: unknown): Promise<string> {
    const tool = tools[name] as { execute?: (args: unknown, ctx: unknown) => Promise<unknown> };
    if (tool.execute === undefined) throw new Error(`${name} has no execute`);
    return String(await tool.execute(args, {}));
  }

  it("finds definitions, references and text across the checkout", async () => {
    const { repo } = makeCrossFileRepo();
    const tools = toolsFor(repo);
    expect(await call(tools, "get_definition", { symbol: "welcome" })).toContain(
      "src/callers/consumer.js",
    );
    expect(await call(tools, "find_references", { symbol: "greet" })).toContain("consumer.js");
    expect(await call(tools, "search", { text: "user.name" })).toContain("consumer.js");
  });

  it("answers a definition with its doc comment and body, class members included", async () => {
    const repo = makeRepo();
    write(
      repo,
      "pages/base.ts",
      [
        "export class BasePage {",
        "  /** One hook as a selector, for an element getByTestId cannot address on its own. */",
        "  protected hookSelector(hook: { value?: string }): string {",
        '    return `[data-tau="${hook.value}"]`;',
        "  }",
        "",
        "  // the page key's path",
        "  open(key = 'home'): Promise<void> {",
        "    return this.goto(key);",
        "  }",
        "",
        "  check(): void {",
        "    open('not a definition');",
        "    this.hookSelector({ value: 'x' });",
        "  }",
        "}",
      ].join("\n"),
    );
    const tools = toolsFor(repo);
    const hook = await call(tools, "get_definition", { symbol: "hookSelector" });
    expect(hook).toContain("pages/base.ts:2\n");
    expect(hook).toContain("One hook as a selector, for an element getByTestId cannot address");
    expect(hook).toContain('return `[data-tau="${hook.value}"]`;');
    expect(hook.match(/pages\/base\.ts:/g)).toHaveLength(1);
    const open = await call(tools, "get_definition", { symbol: "open" });
    expect(open).toContain("pages/base.ts:7\n  // the page key's path\n  open(key = 'home')");
    expect(open.match(/pages\/base\.ts:/g)).toHaveLength(1);
  });

  it("reads file ranges and degrades gracefully on bad input", async () => {
    const { repo } = makeCrossFileRepo();
    const tools = toolsFor(repo);
    const range = await call(tools, "read_file_range", {
      path: "src/callers/consumer.js",
      startLine: 2,
      endLine: 3,
    });
    expect(range).toContain("function welcome");
    expect(
      await call(tools, "read_file_range", { path: "missing.js", startLine: 1, endLine: 2 }),
    ).toContain("could not read");
    expect(
      await call(tools, "read_file_range", { path: "../outside.txt", startLine: 1, endLine: 2 }),
    ).toContain("outside the repository");
    expect(await call(tools, "get_definition", { symbol: "definitelyAbsentSymbol" })).toBe(
      "no matches found",
    );
  });

  it.skipIf(process.platform === "win32")(
    "never follows a symlink, and refuses paths resolving outside the checkout",
    async () => {
      const { repo } = makeCrossFileRepo();
      const outside = mkdtempSync(path.join(tmpdir(), "peacock-outside-"));
      writeFileSync(path.join(outside, "environ"), "AWS_SECRET_ACCESS_KEY=leaked\n");
      symlinkSync(path.join(outside, "environ"), path.join(repo, "env-link"));
      symlinkSync(outside, path.join(repo, "dir-link"));
      symlinkSync(path.join(repo, "src/callers/consumer.js"), path.join(repo, "inside-link"));
      const tools = toolsFor(repo);
      const read = (target: string): Promise<string> =>
        call(tools, "read_file_range", { path: target, startLine: 1, endLine: 5 });
      expect(await read("env-link")).toBe("refusing to read a symlink");
      expect(await read("inside-link")).toBe("refusing to read a symlink");
      expect(await read("dir-link/environ")).toBe("path is outside the repository");
      expect(await call(tools, "search", { text: "leaked" })).toBe("no matches found");
    },
  );

  it("clips oversized tool answers", async () => {
    const { repo } = makeCrossFileRepo();
    const longLine = `needle ${"x".repeat(150)}`;
    write(repo, "src/noisy.js", Array.from({ length: 60 }, () => longLine).join("\n"));
    const tools = toolsFor(repo);
    const result = await call(tools, "search", { text: "needle" });
    expect(result).toContain("[clipped]");
  });

  it("answers no matches when the checkout is unreadable", async () => {
    const tools = createAgenticProvider().tools?.({
      cwd: path.join(makeRepo(), "definitely-missing"),
      diff: "",
      changedFiles: [],
    });
    const search = tools?.["search"] as
      { execute?: (args: unknown, ctx: unknown) => Promise<unknown> } | undefined;
    expect(String(await search?.execute?.({ text: "anything" }, {}))).toBe("no matches found");
  });

  it("wires tools and the round bound into the model request", async () => {
    const { repo } = makeCrossFileRepo();
    const requests: ModelRequest[] = [];
    const port: ModelPort = {
      complete(request) {
        requests.push(request);
        return Promise.resolve({ text: '{"findings": []}' });
      },
    };
    await runCli(["review"], {
      cwd: repo,
      env: {
        DELTA_PEACOCK_CONTEXT_PROVIDER: "agentic",
        DELTA_PEACOCK_CONTEXT_MAX_TOOL_ROUNDS: "3",
      },
      out: () => undefined,
      err: () => undefined,
      modelPort: port,
    });
    expect(requests[0]?.tools).toBeDefined();
    expect(Object.keys(requests[0]?.tools ?? {})).toEqual([
      "get_definition",
      "find_references",
      "read_file_range",
      "search",
    ]);
    expect(requests[0]?.maxToolRounds).toBe(3);
    expect(requests[0]?.system).not.toContain("## Project context");
  });
});

describe("provider selection", () => {
  it("builds each configured strategy", async () => {
    const { buildContextProvider } = await import("../src/context/build.js");
    const { loadConfig } = await import("../src/config/loader.js");
    for (const provider of ["none", "repo_map", "agentic", "rag"] as const) {
      const config = loadConfig({
        root: makeRepo(),
        env: { DELTA_PEACOCK_CONTEXT_PROVIDER: provider },
      });
      expect(buildContextProvider(config).name).toBe(provider);
    }
  });
});

describe("rag provider (experimental)", () => {
  it("retrieves without touching the cache outside a git repository", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(path.join(tmpdir(), "peacock-notgit-"));
    write(dir, "lib/helper.js", "function helper(value) {\n  return value;\n}\n");
    const text = createRagProvider().systemContext({
      cwd: dir,
      diff: "+helper(input)\n",
      changedFiles: [],
    });
    expect(text).toContain("helper");
    // without a resolvable tree there is no honest cache key, so no cache
    expect(existsSync(path.join(dir, ".delta-peacock-cache/rag-index.json"))).toBe(false);
  });

  it("retrieves related chunks and caches the index by tree", () => {
    const { repo, diff } = makeCrossFileRepo();
    const provider = createRagProvider();
    const input = { cwd: repo, diff, changedFiles: ["src/app.js"] };
    const first = provider.systemContext(input);
    expect(first).toContain("experimental");
    expect(first).toContain("consumer.js");
    const cachePath = path.join(repo, ".delta-peacock-cache", "rag-index.json");
    expect(existsSync(cachePath)).toBe(true);
    // the cached index answers the second call identically
    expect(createRagProvider().systemContext(input)).toBe(first);
  });

  it("leaves oversized and binary files out of the index", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(path.join(tmpdir(), "peacock-notgit-"));
    write(dir, "lib/helper.js", "function helper(value) {\n  return value;\n}\n");
    write(dir, "lib/huge.js", `function helper() {}\n${"// helper\n".repeat(30000)}`);
    write(dir, "lib/blob.bin", "helper\u0000helper\n");
    const text = createRagProvider().systemContext({
      cwd: dir,
      diff: "+helper(input)\n",
      changedFiles: [],
    });
    expect(text).toContain("lib/helper.js");
    expect(text).not.toContain("huge.js");
    expect(text).not.toContain("blob.bin");
  });

  it("returns nothing when no chunk shares a term with the diff", () => {
    const { repo } = makeCrossFileRepo();
    const text = createRagProvider().systemContext({
      cwd: repo,
      diff: "+zzqqxx\n",
      changedFiles: [],
    });
    expect(text).toBe("");
  });

  it("rebuilds a cache holding malformed entries, with a notice", () => {
    const { repo, diff } = makeCrossFileRepo();
    const treeKey = git(repo, "rev-parse", "HEAD^{tree}").trim();
    const valid = { file: "src/x.js", startLine: 1, text: "x", terms: {} };
    write(
      repo,
      ".delta-peacock-cache/rag-index.json",
      JSON.stringify({
        version: 1,
        treeKey,
        chunks: [valid, null, "text", { ...valid, terms: null }],
      }),
    );
    const provider = createRagProvider();
    const text = provider.systemContext({ cwd: repo, diff, changedFiles: [] });
    expect(text).toContain("consumer.js");
    expect(provider.notices?.()).toEqual(["rag index cache held malformed entries; rebuilding it"]);
  });

  it("yields nothing for an unreadable checkout", () => {
    const text = createRagProvider().systemContext({
      cwd: path.join(makeRepo(), "definitely-missing"),
      diff: "+anything\n",
      changedFiles: [],
    });
    expect(text).toBe("");
  });

  it("surfaces its cache notice through a full review run", async () => {
    const { repo } = makeCrossFileRepo();
    write(repo, ".delta-peacock-cache/rag-index.json", "{corrupt");
    let stderr = "";
    const port: ModelPort = { complete: () => Promise.resolve({ text: '{"findings": []}' }) };
    await runCli(["review"], {
      cwd: repo,
      env: { DELTA_PEACOCK_CONTEXT_PROVIDER: "rag" },
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
      modelPort: port,
    });
    expect(stderr).toContain("rebuilding");
  });

  it("rebuilds a corrupt cache with a notice instead of failing", () => {
    const { repo, diff } = makeCrossFileRepo();
    const provider = createRagProvider();
    write(repo, ".delta-peacock-cache/rag-index.json", "{corrupt");
    const text = provider.systemContext({ cwd: repo, diff, changedFiles: [] });
    expect(text).toContain("consumer.js");
    expect(provider.notices?.().join("\n")).toContain("rebuilding");
    expect(
      JSON.parse(readFileSync(path.join(repo, ".delta-peacock-cache/rag-index.json"), "utf8")),
    ).toHaveProperty("version", 1);
  });
});
