import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config/loader.js";

function makeRoot(yaml?: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "peacock-config-"));
  if (yaml !== undefined) {
    writeFileSync(path.join(root, "delta-peacock.config.yaml"), yaml);
  }
  return root;
}

function problemsOf(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error("expected a ConfigError");
}

describe("config loading", () => {
  it("resolves documented defaults from an empty root", () => {
    const config = loadConfig({ root: makeRoot() });
    expect(config.model.provider).toBe("anthropic");
    expect(config.review.target).toBe("main");
    expect(config.review.guidelinesDir).toBe("guidelines");
    expect(config.gate.failOn).toBe("none");
    expect(config.output.report).toBeUndefined();
  });

  it("lets the config file override defaults", () => {
    const config = loadConfig({ root: makeRoot("gate:\n  failOn: MINOR\n") });
    expect(config.gate.failOn).toBe("MINOR");
  });

  it("lets environment variables override the file", () => {
    const config = loadConfig({
      root: makeRoot("gate:\n  failOn: MINOR\n"),
      env: { DELTA_PEACOCK_GATE_FAIL_ON: "MAJOR" },
    });
    expect(config.gate.failOn).toBe("MAJOR");
  });

  it("lets flags override environment variables", () => {
    const config = loadConfig({
      root: makeRoot("gate:\n  failOn: MINOR\n"),
      env: { DELTA_PEACOCK_GATE_FAIL_ON: "MAJOR" },
      flags: { "gate.failOn": "BLOCKER" },
    });
    expect(config.gate.failOn).toBe("BLOCKER");
  });

  it("applies several environment overrides under the same section", () => {
    const config = loadConfig({
      root: makeRoot(),
      env: {
        DELTA_PEACOCK_MODEL_PROVIDER: "openrouter",
        DELTA_PEACOCK_MODEL_ID: "some/model",
      },
    });
    expect(config.model.provider).toBe("openrouter");
    expect(config.model.id).toBe("some/model");
  });

  it("treats empty environment values as unset", () => {
    const config = loadConfig({
      root: makeRoot("gate:\n  failOn: MINOR\n"),
      env: { DELTA_PEACOCK_GATE_FAIL_ON: "" },
    });
    expect(config.gate.failOn).toBe("MINOR");
  });

  it("reports every violation at once", () => {
    const problems = problemsOf(() =>
      loadConfig({ root: makeRoot("gate:\n  failOn: WHENEVER\nmodel:\n  provider: acme\n") }),
    );
    expect(problems.length).toBeGreaterThanOrEqual(2);
    expect(problems.join("\n")).toContain("gate.failOn");
    expect(problems.join("\n")).toContain("model.provider");
  });

  it("reports credential keys and schema violations in the same pass", () => {
    const problems = problemsOf(() =>
      loadConfig({ root: makeRoot("gate:\n  failOn: WHENEVER\nmodel:\n  apiKey: sk-x\n") }),
    );
    const joined = problems.join("\n");
    expect(joined).toContain("model.apiKey");
    expect(joined).toContain("gate.failOn");
    expect(joined.match(/apiKey/g)).toHaveLength(1);
  });

  it("rejects credential-shaped keys in the file, pointing at environment variables", () => {
    const problems = problemsOf(() =>
      loadConfig({ root: makeRoot("model:\n  apiKey: sk-something\n") }),
    );
    expect(problems.join("\n")).toContain("model.apiKey");
    expect(problems.join("\n").toLowerCase()).toContain("environment");
  });

  it("rejects unknown keys so typos fail loudly", () => {
    expect(() => loadConfig({ root: makeRoot("gaet:\n  failOn: MAJOR\n") })).toThrow(ConfigError);
  });

  it("enforces cross-field rules with a clear message", () => {
    const problems = problemsOf(() =>
      loadConfig({ root: makeRoot("model:\n  provider: openai-compatible\n") }),
    );
    expect(problems.join("\n")).toContain("model.baseUrl");
    expect(problems.join("\n")).toContain("openai-compatible");
  });

  it("returns a deeply frozen config", () => {
    const config = loadConfig({ root: makeRoot() });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.gate)).toBe(true);
    expect(() => {
      (config.gate as { failOn: string }).failOn = "MAJOR";
    }).toThrow(TypeError);
  });

  it("labels root-level problems as config", () => {
    const problems = problemsOf(() => loadConfig({ root: makeRoot(), flags: { "": "x" } }));
    expect(problems.join("\n")).toContain("config:");
  });

  it("coerces list, number and boolean settings from string sources", () => {
    const config = loadConfig({
      root: makeRoot(),
      env: {
        DELTA_PEACOCK_REVIEW_INCLUDE: "src/**, lib/**",
        DELTA_PEACOCK_REVIEW_MAX_DIFF_BYTES: "2048",
        DELTA_PEACOCK_REVIEW_FETCH_TARGET: "false",
      },
    });
    expect(config.review.include).toEqual(["src/**", "lib/**"]);
    expect(config.review.maxDiffBytes).toBe(2048);
    expect(config.review.fetchTarget).toBe(false);
  });

  it("accepts a true boolean string", () => {
    const config = loadConfig({
      root: makeRoot(),
      env: { DELTA_PEACOCK_REVIEW_FETCH_TARGET: "true" },
    });
    expect(config.review.fetchTarget).toBe(true);
  });

  it("rejects unusable number and boolean strings with clear paths", () => {
    const problems = problemsOf(() =>
      loadConfig({
        root: makeRoot(),
        env: {
          DELTA_PEACOCK_REVIEW_MAX_DIFF_BYTES: "ten",
          DELTA_PEACOCK_REVIEW_FETCH_TARGET: "yes",
        },
      }),
    );
    const joined = problems.join("\n");
    expect(joined).toContain("review.maxDiffBytes");
    expect(joined).toContain("review.fetchTarget");
  });

  it("treats an empty config file as no overrides", () => {
    const config = loadConfig({ root: makeRoot("") });
    expect(config.gate.failOn).toBe("none");
  });

  it("rejects a config file that is not a mapping", () => {
    const problems = problemsOf(() => loadConfig({ root: makeRoot("- just\n- a\n- list\n") }));
    expect(problems.join("\n")).toContain("mapping");
  });
});
