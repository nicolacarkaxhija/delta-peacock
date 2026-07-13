import { createRequire } from "node:module";
import { Command } from "commander";
import { loadConfig } from "./config/loader.js";
import type { RuntimeDeps } from "./deps.js";
import { ExitCodeError } from "./errors.js";
import { runGuidelinesLint } from "./guidelines/lint.js";
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
  guidelinesRef?: string;
  report?: string;
  include?: string;
  exclude?: string;
  maxDiffBytes?: string;
  lastReviewedCommit?: string;
}

const REVIEW_FLAG_PATHS: Readonly<Record<keyof ReviewCommandOptions, string>> = {
  target: "review.target",
  failOn: "gate.failOn",
  guidelinesDir: "review.guidelinesDir",
  guidelinesRef: "review.guidelinesRef",
  report: "output.report",
  include: "review.include",
  exclude: "review.exclude",
  maxDiffBytes: "review.maxDiffBytes",
  lastReviewedCommit: "review.lastReviewedCommit",
};

interface ReviewCommandBooleans {
  dryRun?: boolean;
}

function reviewFlags(options: ReviewCommandOptions): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const [key, dotPath] of Object.entries(REVIEW_FLAG_PATHS)) {
    const value = options[key as keyof ReviewCommandOptions];
    if (value !== undefined) flags[dotPath] = value;
  }
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
    .option("--guidelines-ref <ref>", "read guidelines from: target, source, or a git ref")
    .option("--report <path>", "write the JSON report to this path")
    .option("--include <globs>", "comma-separated path globs to review")
    .option("--exclude <globs>", "comma-separated path globs to leave out")
    .option("--max-diff-bytes <n>", "skip reviews larger than this many bytes")
    .option("--last-reviewed-commit <sha>", "review only changes since this commit")
    .option("--dry-run", "suppress every outbound write, whatever is configured")
    .action(async (options: ReviewCommandOptions & ReviewCommandBooleans) => {
      const flags = reviewFlags(options);
      if (options.dryRun === true) flags["scm.dryRun"] = "true";
      const code = await runReview(
        {
          cwd: deps.cwd,
          env: deps.env,
          out: deps.out,
          err: deps.err,
          ...(deps.modelPort ? { modelPort: deps.modelPort } : {}),
          ...(deps.scmPort ? { scmPort: deps.scmPort } : {}),
        },
        flags,
      );
      if (code !== 0) throw new ExitCodeError(code);
    });

  program
    .command("doctor")
    .description("validate the setup without reviewing anything")
    .action(async () => {
      const { runDoctor } = await import("./commands/doctor.js");
      const code = await runDoctor(deps, {});
      if (code !== 0) throw new ExitCodeError(code);
    });

  program
    .command("init")
    .description("scaffold config, an example guideline and a CI snippet")
    .option("--force", "overwrite files that already exist")
    .action(async (options: { force?: boolean }) => {
      const { runInit } = await import("./commands/init.js");
      const code = runInit(deps, { force: options.force === true });
      if (code !== 0) throw new ExitCodeError(code);
    });

  const guidelines = program.command("guidelines").description("guideline corpus utilities");
  guidelines
    .command("lint")
    .description("validate every guideline file in the working tree")
    .option("--guidelines-dir <dir>", "directory holding guideline markdown files")
    .action((options: { guidelinesDir?: string }) => {
      const flags: Record<string, string> = {};
      if (options.guidelinesDir !== undefined) {
        flags["review.guidelinesDir"] = options.guidelinesDir;
      }
      const code = runGuidelinesLint(deps, flags);
      if (code !== 0) throw new ExitCodeError(code);
    });

  return program;
}
