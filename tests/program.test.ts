import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import { describeError } from "../src/run-cli.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
  description: string;
};

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  argv: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    cwd: options.cwd ?? mkdtempSync(path.join(tmpdir(), "peacock-cli-")),
    env: options.env ?? {},
    out: (text) => {
      stdout += text;
    },
    err: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

function makeRoot(yaml?: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "peacock-cli-"));
  if (yaml !== undefined) {
    writeFileSync(path.join(root, "delta-peacock.config.yaml"), yaml);
  }
  return root;
}

describe("cli", () => {
  it("prints the package version and exits clean", async () => {
    const { code, stdout } = await run(["--version"]);
    expect(stdout.trim()).toBe(manifest.version);
    expect(code).toBe(0);
  });

  it("describes itself in help and exits clean", async () => {
    const { code, stdout } = await run(["--help"]);
    expect(stdout).toContain(manifest.description);
    expect(stdout).toContain("config");
    expect(code).toBe(0);
  });

  it("fails on an unknown command", async () => {
    const { code, stderr } = await run(["frobnicate"]);
    expect(code).toBe(1);
    expect(stderr).toContain("frobnicate");
  });

  describe("describeError", () => {
    it.each([
      { thrown: new Error("went wrong"), text: "went wrong" },
      { thrown: "plain string", text: "plain string" },
      { thrown: { code: 7 }, text: '{"code":7}' },
      { thrown: 42, text: "42" },
    ])("describes $text", ({ thrown, text }) => {
      expect(describeError(thrown)).toBe(text);
    });

    it("degrades safely on unserializable values", () => {
      const circular: Record<string, unknown> = {};
      circular["self"] = circular;
      expect(describeError(circular)).toBe("unserializable error");
      expect(describeError({ toJSON: () => undefined })).toBe("unserializable error");
    });
  });

  describe("config command", () => {
    it("prints the resolved effective configuration", async () => {
      const cwd = makeRoot("gate:\n  failOn: MINOR\n");
      const { code, stdout } = await run(["config"], { cwd });
      expect(code).toBe(0);
      const printed = JSON.parse(stdout) as {
        gate: { failOn: string };
        review: { target: string };
      };
      expect(printed.gate.failOn).toBe("MINOR");
      expect(printed.review.target).toBe("main");
    });

    it("applies environment overrides from the injected environment", async () => {
      const cwd = makeRoot("gate:\n  failOn: MINOR\n");
      const { code, stdout } = await run(["config"], {
        cwd,
        env: { DELTA_PEACOCK_GATE_FAIL_ON: "MAJOR" },
      });
      expect(code).toBe(0);
      expect((JSON.parse(stdout) as { gate: { failOn: string } }).gate.failOn).toBe("MAJOR");
    });

    it("exits with the tool-error code listing every violation", async () => {
      const cwd = makeRoot("gate:\n  failOn: WHENEVER\nmodel:\n  provider: acme\n");
      const { code, stderr } = await run(["config"], { cwd });
      expect(code).toBe(1);
      expect(stderr).toContain("gate.failOn");
      expect(stderr).toContain("model.provider");
      expect(stderr).toContain("2 problem(s)");
    });

    it("surfaces unreadable yaml as a tool error", async () => {
      const cwd = makeRoot("gate: [unclosed\n");
      const { code, stderr } = await run(["config"], { cwd });
      expect(code).toBe(1);
      expect(stderr.length).toBeGreaterThan(0);
    });
  });
});
