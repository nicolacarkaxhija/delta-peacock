import { detectCi } from "../../src/config/ci.js";
import { loadCredentials } from "../../src/config/credentials.js";
import { loadConfig } from "../../src/config/loader.js";
import type { RuntimeDeps } from "../../src/deps.js";
import type { CliDeps } from "../../src/run-cli.js";

/**
 * Builds a full RuntimeDeps from a flat env record, for the handful of tests
 * that call a command function directly instead of going through runCli (the
 * usual composition root). The result also satisfies CliDeps, so the same
 * value works if the test hands it to runCli too.
 */
export function testDeps(
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = {},
  overrides: Partial<RuntimeDeps> = {},
): RuntimeDeps & CliDeps {
  return {
    cwd,
    env,
    loadConfig: (flags) =>
      loadConfig({ root: cwd, env, ...(flags !== undefined ? { flags } : {}) }),
    credentials: loadCredentials(env),
    ci: detectCi(env),
    out: () => undefined,
    err: () => undefined,
    ...overrides,
  };
}
