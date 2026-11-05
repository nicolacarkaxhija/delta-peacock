import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SEMGREP_PIN } from "../src/review/semgrep/run.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies: Record<string, string>;
  bundleDependencies: string[];
  semgrep: { version: string; wheels: Record<string, { url: string; sha256: string }> };
};

describe("package manifest", () => {
  it("bundles every runtime dependency, so the tarball installs offline", () => {
    expect([...manifest.bundleDependencies].sort()).toEqual(
      Object.keys(manifest.dependencies).sort(),
    );
  });

  it("pins the semgrep the reviewer runs, one checked wheel per platform", () => {
    expect(manifest.semgrep.version).toBe(SEMGREP_PIN);
    for (const wheel of Object.values(manifest.semgrep.wheels)) {
      expect(wheel.url).toContain(`/semgrep-${SEMGREP_PIN}-`);
      expect(wheel.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
