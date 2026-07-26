import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import type { ModelPort, ModelRequest } from "../src/model/port.js";

const GUIDELINE = "---\nid: no-console\nseverity: MAJOR\n---\n# No console\n\nUse the logger.\n";
const DIFF = [
  "diff --git a/src/app.js b/src/app.js",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/app.js",
  "@@ -0,0 +1,1 @@",
  "+console.log('x');",
  "",
].join("\n");

function capture(): { requests: ModelRequest[]; port: ModelPort } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    port: {
      complete(request) {
        requests.push(request);
        return Promise.resolve({ text: '{"findings": []}' });
      },
    },
  };
}

/** A one-case bench directory, with a linter marker file at its own root. */
function benchCasesDir(): string {
  const casesDir = mkdtempSync(path.join(tmpdir(), "peacock-bench-parity-"));
  const caseDir = path.join(casesDir, "01-single-file");
  mkdirSync(path.join(caseDir, "guidelines"), { recursive: true });
  writeFileSync(path.join(caseDir, "diff.patch"), DIFF);
  writeFileSync(path.join(caseDir, "guidelines", "no-console.md"), GUIDELINE);
  writeFileSync(path.join(caseDir, ".eslintrc.json"), "{}\n");
  return casesDir;
}

/** An audit tree with the same guideline, file and linter marker as the bench case. */
function auditRepoDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "peacock-audit-parity-"));
  mkdirSync(path.join(root, "guidelines"), { recursive: true });
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "guidelines", "no-console.md"), GUIDELINE);
  writeFileSync(path.join(root, "src", "app.js"), "console.log('x');\n");
  writeFileSync(path.join(root, ".eslintrc.json"), "{}\n");
  return root;
}

describe("bench and audit build the same review input", () => {
  it("both pass the configured language and detected linters to the prompt", async () => {
    const env = { DELTA_PEACOCK_REVIEW_LANGUAGE: "de" };

    const benchCapture = capture();
    const benchCode = await runCli(["bench", "--cases", benchCasesDir(), "--context", "none"], {
      cwd: mkdtempSync(path.join(tmpdir(), "peacock-bench-cwd-")),
      env,
      out: () => undefined,
      err: () => undefined,
      modelPort: benchCapture.port,
    });
    expect(benchCode).toBe(0);

    const auditCapture = capture();
    const auditCode = await runCli(["audit"], {
      cwd: auditRepoDir(),
      env,
      out: () => undefined,
      err: () => undefined,
      modelPort: auditCapture.port,
    });
    expect(auditCode).toBe(0);

    const benchSystem = benchCapture.requests[0]?.system ?? "";
    const auditSystem = auditCapture.requests[0]?.system ?? "";

    // language: bench used to omit this field entirely
    expect(benchSystem).toContain("language tagged de");
    expect(auditSystem).toContain("language tagged de");

    // detected linters: bench used to omit this field entirely
    expect(benchSystem).toContain("eslint");
    expect(auditSystem).toContain("eslint");
  });
});
