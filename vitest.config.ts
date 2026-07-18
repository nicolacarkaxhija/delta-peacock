import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 40000,
    // fake-server e2e tests occasionally lose a local socket under full
    // parallel load on Windows; deterministic failures still fail twice.
    // Worker cap keeps dozens of short-lived HTTP servers off the same
    // instant; the longer timeout absorbs a loaded retry.
    retry: 1,
    maxWorkers: 4,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/cli.ts"],
      thresholds: {
        lines: 95,
        branches: 95,
        functions: 95,
        statements: 95,
      },
    },
  },
});
