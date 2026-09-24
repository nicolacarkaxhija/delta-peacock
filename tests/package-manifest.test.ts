import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies: Record<string, string>;
  bundleDependencies: string[];
};

describe("package manifest", () => {
  it("bundles every runtime dependency, so the tarball installs offline", () => {
    expect([...manifest.bundleDependencies].sort()).toEqual(
      Object.keys(manifest.dependencies).sort(),
    );
  });
});
