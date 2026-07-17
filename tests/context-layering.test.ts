import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { activeStrategies, buildContextProvider } from "../src/context/build.js";
import { loadConfig } from "../src/config/loader.js";
import { runCli } from "../src/index.js";
import type { ModelPort, ModelRequest } from "../src/model/port.js";
import { mergeBaseDiff } from "../src/git/diff.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const GUIDELINE = "---\nid: no-console\nseverity: MAJOR\n---\n# No console\n\nUse the logger.\n";

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

describe("configuration of layered strategies", () => {
  it.each([
    { env: {}, expected: ["repo_map"] },
    { env: { DELTA_PEACOCK_CONTEXT_PROVIDER: "none" }, expected: [] },
    { env: { DELTA_PEACOCK_CONTEXT_PROVIDER: "rag" }, expected: ["rag"] },
    {
      env: { DELTA_PEACOCK_CONTEXT_PROVIDERS: "repo_map,agentic" },
      expected: ["repo_map", "agentic"],
    },
    {
      // the layered list wins over the single setting
      env: {
        DELTA_PEACOCK_CONTEXT_PROVIDER: "none",
        DELTA_PEACOCK_CONTEXT_PROVIDERS: "rag,repo_map",
      },
      expected: ["rag", "repo_map"],
    },
  ])("resolves $env", ({ env, expected }) => {
    const config = loadConfig({ root: makeRepo(), env });
    expect(activeStrategies(config)).toEqual(expected);
  });

  it("rejects duplicates and the none strategy inside the list", () => {
    expect(() =>
      loadConfig({
        root: makeRepo(),
        env: { DELTA_PEACOCK_CONTEXT_PROVIDERS: "repo_map,repo_map" },
      }),
    ).toThrow(/twice/);
    expect(() =>
      loadConfig({ root: makeRepo(), env: { DELTA_PEACOCK_CONTEXT_PROVIDERS: "none,repo_map" } }),
    ).toThrow();
  });
});

describe("composed provider behavior", () => {
  it("concatenates context sections in priority order", () => {
    const { repo, diff } = makeCrossFileRepo();
    const config = loadConfig({
      root: repo,
      env: { DELTA_PEACOCK_CONTEXT_PROVIDERS: "repo_map,rag" },
    });
    const provider = buildContextProvider(config);
    expect(provider.name).toBe("repo_map+rag");
    const text = provider.systemContext({ cwd: repo, diff, changedFiles: ["src/app.js"] });
    const mapAt = text.indexOf("Signature map of related files");
    const ragAt = text.indexOf("Retrieved repository excerpts");
    expect(mapAt).toBeGreaterThanOrEqual(0);
    expect(ragAt).toBeGreaterThan(mapAt); // earlier strategy leads the budget
    expect(provider.notices?.()).toEqual([]);
  });

  it("keeps a tool-less composition free of a tools method", () => {
    const config = loadConfig({
      root: makeRepo(),
      env: { DELTA_PEACOCK_CONTEXT_PROVIDERS: "repo_map,rag" },
    });
    expect("tools" in buildContextProvider(config)).toBe(false);
  });

  it("layers the map into the prompt and the tools into the request together", async () => {
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
      env: { DELTA_PEACOCK_CONTEXT_PROVIDERS: "repo_map,agentic" },
      out: () => undefined,
      err: () => undefined,
      modelPort: port,
    });
    expect(code).toBe(0);
    const request = requests[0];
    expect(request?.system).toContain("## Project context");
    expect(request?.system).toContain("consumer.js"); // the map found the caller
    expect(Object.keys(request?.tools ?? {})).toEqual([
      "get_definition",
      "find_references",
      "read_file_range",
      "search",
    ]);
  });
});

describe("bench over layered variants", () => {
  it("understands plus-joined combos in the contexts list", async () => {
    const casesDir = fileURLToPath(new URL("../bench/cases", import.meta.url));
    const contextSensitive: ModelPort = {
      complete(request) {
        const findings = [];
        if (request.system.includes("checkout.js")) {
          findings.push({
            guidelineId: "no-breaking-signature-change",
            file: "src/pricing.js",
            line: 1,
            title: "s",
            body: "b",
          });
        }
        return Promise.resolve({ text: JSON.stringify({ findings }) });
      },
    };
    let stdout = "";
    const code = await runCli(["bench", "--cases", casesDir, "--contexts", "none,repo_map+rag"], {
      cwd: makeRepo(),
      env: {},
      out: (text) => {
        stdout += text;
      },
      err: () => undefined,
      modelPort: contextSensitive,
    });
    expect(code).toBe(0);
    expect(stdout).toContain("context = repo_map+rag");
    const comboRows = stdout
      .split("\n")
      .filter((line) => line.includes("02-cross-file") && line.includes("100%"));
    expect(comboRows.length).toBeGreaterThan(0); // the layered variant caught it
  });
});
