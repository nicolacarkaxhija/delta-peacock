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
  command: string;
  timeoutMs: number;
}

/** The Semgrep CLI as a child process. */
export function semgrepRunner(options: RunnerOptions): SemgrepRunner {
  return () => Promise.resolve({ ok: false, reason: `not built: ${options.command}` });
}
