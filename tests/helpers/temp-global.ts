import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    tempRunRoot: string;
  }
}

/** Names the suite and the reviewer give their temp directories. */
const OURS = /^(peacock|dp|bt|delta-peacock)-/;

/** One root per run; teardown fails the run when anything was left behind. */
export default function setup(project: TestProject): () => void {
  const outer = tmpdir();
  const before = new Set(readdirSync(outer));
  const runRoot = mkdtempSync(path.join(outer, "peacock-test-run-"));
  project.provide("tempRunRoot", runRoot);
  return () => {
    const left = readdirSync(runRoot);
    rmSync(runRoot, { recursive: true, force: true, maxRetries: 3 });
    const escaped = readdirSync(outer).filter((name) => OURS.test(name) && !before.has(name));
    if (left.length > 0 || escaped.length > 0) {
      throw new Error(
        `the tests left temp directories behind: ${[...left, ...escaped].join(", ")}`,
      );
    }
  };
}
