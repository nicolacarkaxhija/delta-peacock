import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The Semgrep release the reviewer runs; package.json pins the same one for the installer. */
export const SEMGREP_PIN = "1.183.0";

/** One rule match, as Semgrep reports it. */
export interface SemgrepHit {
  ruleId: string;
  path: string;
  startLine: number;
  endLine: number;
}

export type SemgrepRun =
  | { ok: true; version: string; hits: SemgrepHit[]; warnings: string[] }
  | { ok: false; reason: string };

/** Runs a rule config over the given files, keyed by repository path. */
export type SemgrepRunner = (
  config: string,
  files: ReadonlyMap<string, string>,
) => Promise<SemgrepRun>;

export interface RunnerOptions {
  /** The Semgrep CLI: the pinned osemgrep the installer puts in place, or any semgrep on the path. */
  command: string;
  timeoutMs: number;
}

export const MS_PER_SECOND = 1000;

interface Output {
  version?: unknown;
  results?: unknown;
  errors?: { message?: string; path?: string }[];
}

interface Result {
  check_id: string;
  path: string;
  start: { line: number };
  end: { line: number };
}

/** What a finished process printed, read into a run. */
function readOutput(stdout: string): SemgrepRun {
  let output: Output;
  try {
    output = JSON.parse(stdout) as Output;
  } catch {
    return { ok: false, reason: "semgrep output is unreadable" };
  }
  if (!Array.isArray(output.results)) return { ok: false, reason: "semgrep output is unreadable" };
  if (output.version !== SEMGREP_PIN) {
    return {
      ok: false,
      reason: `semgrep ${String(output.version)} ran where the reviewer pins ${SEMGREP_PIN}`,
    };
  }
  return {
    ok: true,
    version: SEMGREP_PIN,
    hits: (output.results as Result[]).map((result) => ({
      ruleId: result.check_id,
      path: result.path,
      startLine: result.start.line,
      endLine: result.end.line,
    })),
    warnings: (output.errors ?? []).map((error) => {
      const message = String(error.message).split("\n", 1).join("");
      return error.path === undefined ? message : `${error.path}: ${message}`;
    }),
  };
}

/**
 * The Semgrep CLI as a child process over copies of the changed files, so a
 * staged or partial checkout scans what the review reads. It runs offline:
 * metrics off, no version check, rules from the local config only.
 */
export function semgrepRunner(options: RunnerOptions): SemgrepRunner {
  return (config, files) => {
    const root = mkdtempSync(path.join(tmpdir(), "peacock-semgrep-"));
    const configPath = path.join(root, "rules.yaml");
    const targets = path.join(root, "targets");
    try {
      writeFileSync(configPath, config);
      for (const [file, text] of files) {
        const full = path.join(targets, file);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, text);
      }
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      return Promise.resolve({
        ok: false,
        reason: `semgrep could not stage the changed files: ${(error as Error).message}`,
      });
    }
    const args = [
      "scan",
      "--experimental",
      "--config",
      configPath,
      "--json",
      "--metrics",
      "off",
      "--disable-version-check",
      ...files.keys(),
    ];
    return new Promise<SemgrepRun>((resolve) => {
      let stdout = "";
      let stderr = "";
      const child = spawn(options.command, args, {
        cwd: targets,
        env: { ...process.env, SEMGREP_SEND_METRICS: "off" },
      });
      const done = (run: SemgrepRun): void => {
        clearTimeout(timer);
        rmSync(root, { recursive: true, force: true });
        resolve(run);
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        done({
          ok: false,
          reason: `semgrep timed out after ${String(options.timeoutMs / MS_PER_SECOND)}s`,
        });
      }, options.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", (error: NodeJS.ErrnoException) => {
        done({
          ok: false,
          reason:
            error.code === "ENOENT"
              ? `${options.command} not found; install the pinned semgrep ${SEMGREP_PIN} with node scripts/semgrep-install.mjs`
              : `${options.command} could not start: ${error.message}`,
        });
      });
      child.on("close", (code) => {
        if (code === null) return;
        if (code !== 0) {
          const last = stderr.trim().replace(/^[\s\S]*\n/, "");
          done({
            ok: false,
            reason: `semgrep exited with code ${String(code)}${last === "" ? "" : `: ${last}`}`,
          });
          return;
        }
        done(readOutput(stdout));
      });
    });
  };
}
