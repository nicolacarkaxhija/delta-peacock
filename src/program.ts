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
  writeBaseline?: boolean;
  staged?: boolean;
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
    .option("--write-baseline", "accept every current finding into the baseline file")
    .option("--staged", "review the index against HEAD, for pre-commit hooks")
    .action(async (options: ReviewCommandOptions & ReviewCommandBooleans) => {
      const flags = reviewFlags(options);
      if (options.dryRun === true) flags["scm.dryRun"] = "true";
      const code = await runReview(deps, flags, {
        writeBaseline: options.writeBaseline === true,
        staged: options.staged === true,
      });
      if (code !== 0) throw new ExitCodeError(code);
    });

  program
    .command("audit")
    .description("review the whole tree against the guidelines; posts nothing")
    .option("--guidelines-dir <dir>", "directory holding guideline markdown files")
    .option("--fail-on <severity>", "gate threshold: BLOCKER, CRITICAL, MAJOR, MINOR, INFO or none")
    .option("--report <path>", "write the JSON report to this path")
    .option("--include <globs>", "comma-separated path globs to audit")
    .option("--exclude <globs>", "comma-separated path globs to leave out")
    .option("--write-baseline", "accept every current finding into the baseline file")
    .action(
      async (options: {
        guidelinesDir?: string;
        failOn?: string;
        report?: string;
        include?: string;
        exclude?: string;
        writeBaseline?: boolean;
      }) => {
        const { runAudit } = await import("./commands/audit.js");
        const flags: Record<string, string> = {};
        if (options.guidelinesDir !== undefined)
          flags["review.guidelinesDir"] = options.guidelinesDir;
        if (options.failOn !== undefined) flags["gate.failOn"] = options.failOn;
        if (options.report !== undefined) flags["output.report"] = options.report;
        if (options.include !== undefined) flags["review.include"] = options.include;
        if (options.exclude !== undefined) flags["review.exclude"] = options.exclude;
        const code = await runAudit(deps, flags, {
          writeBaseline: options.writeBaseline === true,
        });
        if (code !== 0) throw new ExitCodeError(code);
      },
    );

  program
    .command("describe")
    .description("generate the marker-fenced section of the pull request description")
    .option("--target <ref>", "branch the changes merge into")
    .option("--title", "also set the pull request title")
    .option("--dry-run", "print the section instead of writing it")
    .action(async (options: { target?: string; title?: boolean; dryRun?: boolean }) => {
      const { runDescribe } = await import("./commands/describe.js");
      const flags: Record<string, string> = {};
      if (options.target !== undefined) flags["review.target"] = options.target;
      if (options.dryRun === true) flags["scm.dryRun"] = "true";
      const code = await runDescribe(deps, flags, { title: options.title === true });
      if (code !== 0) throw new ExitCodeError(code);
    });

  program
    .command("ask")
    .description("answer a question about the current changeset in the terminal")
    .argument("[question]", "what to ask; omit it with --interactive for a session")
    .option("--interactive", "keep asking; .exit or end of input ends the session")
    .option("--target <ref>", "branch the changes merge into")
    .option("--dry-run", "prepare the question but never call the model")
    .action(
      async (
        question: string | undefined,
        options: { interactive?: boolean; target?: string; dryRun?: boolean },
      ) => {
        const { runAsk } = await import("./commands/ask.js");
        const flags: Record<string, string> = {};
        if (options.target !== undefined) flags["review.target"] = options.target;
        if (options.dryRun === true) flags["scm.dryRun"] = "true";
        const code = await runAsk(deps, flags, {
          ...(question !== undefined ? { question } : {}),
          interactive: options.interactive === true,
        });
        if (code !== 0) throw new ExitCodeError(code);
      },
    );

  program
    .command("fix")
    .description("apply the suggestions from a review report to the working tree")
    .option("--report <path>", "review report to read; defaults to output.report")
    .option("--patch-file <path>", "write a unified diff instead of touching files")
    .option("--force", "edit files that have uncommitted changes")
    .action(async (options: { report?: string; patchFile?: string; force?: boolean }) => {
      const { runFix } = await import("./commands/fix.js");
      const code = runFix(
        deps,
        {},
        {
          ...(options.report !== undefined ? { report: options.report } : {}),
          ...(options.patchFile !== undefined ? { patchFile: options.patchFile } : {}),
          force: options.force === true,
        },
      );
      if (code !== 0) throw new ExitCodeError(code);
    });

  program
    .command("learn")
    .description("harvest reactions to past review comments into guideline drafts")
    .option("--drafts-dir <dir>", "where drafts land; defaults to guidelines-drafts")
    .option("--report <path>", "write the evidence and outcomes as JSON")
    .option("--dry-run", "collect the evidence but never call the model")
    .action(async (options: { draftsDir?: string; report?: string; dryRun?: boolean }) => {
      const { runLearn } = await import("./commands/learn.js");
      const flags: Record<string, string> = {};
      if (options.dryRun === true) flags["scm.dryRun"] = "true";
      const code = await runLearn(deps, flags, {
        ...(options.draftsDir !== undefined ? { draftsDir: options.draftsDir } : {}),
        ...(options.report !== undefined ? { report: options.report } : {}),
      });
      if (code !== 0) throw new ExitCodeError(code);
    });

  program
    .command("stats")
    .description("per-contributor findings, normalized per added line; a coaching aid")
    .option("--report <path>", "write the aggregate as JSON")
    .option("--backfill", "reconstruct a record from this pull request's marked comments")
    .action(async (options: { report?: string; backfill?: boolean }) => {
      const { runStats } = await import("./commands/stats.js");
      const code = await runStats(deps, {
        ...(options.report !== undefined ? { report: options.report } : {}),
        backfill: options.backfill === true,
      });
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
    .option("--walkthrough", "choose the configuration through guided questions")
    .action(async (options: { force?: boolean; walkthrough?: boolean }) => {
      if (options.walkthrough === true) {
        const { runInitWalkthrough } = await import("./commands/walkthrough.js");
        const code = await runInitWalkthrough(deps, { force: options.force === true });
        if (code !== 0) throw new ExitCodeError(code);
        return;
      }
      const { runInit } = await import("./commands/init.js");
      runInit(deps, { force: options.force === true });
    });

  program
    .command("bench")
    .description("score the reviewer against benchmark cases")
    .requiredOption(
      "--cases <dir>",
      "directory of case folders (diff.patch, guidelines, expected.json)",
    )
    .option("--report <path>", "write the outcome as JSON")
    .option("--context <provider>", "context strategy to benchmark: none, repo_map, agentic, rag")
    .option("--contexts <list>", "comma-separated strategies to compare with an overlap matrix")
    .action(
      async (options: { cases: string; report?: string; context?: string; contexts?: string }) => {
        const { runBenchCommand, contextFlag } = await import("./commands/bench.js");
        const flags: Record<string, string> = {};
        if (options.context !== undefined) Object.assign(flags, contextFlag(options.context));
        const code = await runBenchCommand(
          deps,
          {
            cases: options.cases,
            ...(options.report !== undefined ? { report: options.report } : {}),
            ...(options.contexts !== undefined
              ? { contexts: options.contexts.split(",").map((name) => name.trim()) }
              : {}),
          },
          flags,
        );
        /* v8 ignore next -- the bench command reports through its outcome, not exit codes */
        if (code !== 0) throw new ExitCodeError(code);
      },
    );

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

  guidelines
    .command("stats")
    .description("per-guideline fire counts and stale-scope signals; zero model calls")
    .option("--report <path>", "write the coverage as JSON")
    .action(async (options: { report?: string }) => {
      const { runGuidelineStats } = await import("./commands/guideline-stats.js");
      const code = runGuidelineStats(deps, {
        ...(options.report !== undefined ? { report: options.report } : {}),
      });
      if (code !== 0) throw new ExitCodeError(code);
    });

  guidelines
    .command("import")
    .description("convert a legacy guideline corpus to the delta-peacock format")
    .requiredOption("--from <dir>", "directory holding legacy guideline markdown files")
    .option("--out <dir>", "write converted files here; defaults to converting in place")
    .action(async (options: { from: string; out?: string }) => {
      const { runGuidelinesImport } = await import("./guidelines/import.js");
      const code = runGuidelinesImport(deps, {
        from: options.from,
        ...(options.out !== undefined ? { out: options.out } : {}),
      });
      /* v8 ignore next -- import reports failures as thrown tool errors, not codes */
      if (code !== 0) throw new ExitCodeError(code);
    });

  const pack = guidelines.command("pack").description("guideline pack utilities");
  pack
    .command("init")
    .description("wrap an existing guidelines directory into a shareable pack")
    .requiredOption("--name <name>", "pack name written to the manifest")
    .option("--dir <dir>", "guidelines directory to wrap; defaults to review.guidelinesDir")
    .option("--out <dir>", "where the pack lands; defaults to packs/<name>")
    .option("--force", "overwrite an existing output directory")
    .action(async (options: { name: string; dir?: string; out?: string; force?: boolean }) => {
      const { runGuidelinesPackInit } = await import("./guidelines/pack-init.js");
      const flags: Record<string, string> = {};
      if (options.dir !== undefined) flags["review.guidelinesDir"] = options.dir;
      const code = runGuidelinesPackInit(deps, flags, {
        name: options.name,
        ...(options.out !== undefined ? { out: options.out } : {}),
        force: options.force === true,
      });
      /* v8 ignore next -- pack init reports failures as thrown tool errors, not codes */
      if (code !== 0) throw new ExitCodeError(code);
    });

  return program;
}
