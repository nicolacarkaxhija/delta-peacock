import { createRequire } from "node:module";
import { Command } from "commander";
import { loadConfig } from "./config/loader.js";
import type { RuntimeDeps } from "./deps.js";
import { ExitCodeError } from "./errors.js";
import { runReview } from "./review/run-review.js";

const require = createRequire(import.meta.url);
const manifest = require("../package.json") as {
  name: string;
  version: string;
  description: string;
};

export type CliDeps = RuntimeDeps;

interface ReviewCommandOptions {
  target?: string;
  failOn?: string;
  guidelinesDir?: string;
  report?: string;
}

function reviewFlags(options: ReviewCommandOptions): Record<string, string> {
  const flags: Record<string, string> = {};
  if (options.target !== undefined) flags["review.target"] = options.target;
  if (options.failOn !== undefined) flags["gate.failOn"] = options.failOn;
  if (options.guidelinesDir !== undefined) flags["review.guidelinesDir"] = options.guidelinesDir;
  if (options.report !== undefined) flags["output.report"] = options.report;
  return flags;
}

export function buildProgram(deps: CliDeps): Command {
  const program = new Command(manifest.name)
    .description(manifest.description)
    .version(manifest.version);
  program.exitOverride();
  program.configureOutput({ writeOut: deps.out, writeErr: deps.err });

  program
    .command("config")
    .description("resolve and print the effective configuration")
    .action(() => {
      const config = loadConfig({ root: deps.cwd, env: deps.env });
      deps.out(`${JSON.stringify(config, null, 2)}\n`);
    });

  program
    .command("review")
    .description("review the current branch against the repository's guidelines")
    .option("--target <ref>", "branch the changes merge into")
    .option("--fail-on <severity>", "gate threshold: BLOCKER, CRITICAL, MAJOR, MINOR, INFO or none")
    .option("--guidelines-dir <dir>", "directory holding guideline markdown files")
    .option("--report <path>", "write the JSON report to this path")
    .action(async (options: ReviewCommandOptions) => {
      const code = await runReview(
        {
          cwd: deps.cwd,
          env: deps.env,
          out: deps.out,
          err: deps.err,
          ...(deps.modelPort ? { modelPort: deps.modelPort } : {}),
        },
        reviewFlags(options),
      );
      if (code !== 0) throw new ExitCodeError(code);
    });

  return program;
}
