import path from "node:path";
import { loadCredentials, type Credentials } from "../config/credentials.js";
import { ConfigError, loadConfig } from "../config/loader.js";
import type { Config } from "../config/schema.js";
import type { RuntimeDeps } from "../deps.js";
import { resolveTargetRef } from "../git/diff.js";
import { runGit } from "../git/git.js";
import { resolveGuidelines } from "../guidelines/loader.js";
import { buildScmPort } from "../scm/build.js";

type CheckLevel = "ok" | "warn" | "fail";

interface CheckResult {
  name: string;
  level: CheckLevel;
  detail: string;
}

function check(name: string, level: CheckLevel, detail: string): CheckResult {
  return { name, level, detail };
}

function checkGit(deps: RuntimeDeps, config: Config): CheckResult {
  try {
    runGit(deps.cwd, ["rev-parse", "--git-dir"]);
  } catch {
    return check("git", "fail", "not a git repository; run inside a checkout");
  }
  try {
    const resolved = resolveTargetRef(deps.cwd, config.review.target, config.review.fetchTarget);
    runGit(deps.cwd, ["merge-base", resolved.ref, "HEAD"]);
    return check("git", "ok", `merge base with ${resolved.ref} resolves`);
  } catch (error) {
    return check(
      "git",
      "fail",
      `cannot compute a merge base with ${config.review.target}: ${String((error as Error).message.split("\n")[0])}; fetch the target or fix review.target`,
    );
  }
}

function checkGuidelines(deps: RuntimeDeps, config: Config): CheckResult {
  try {
    const resolved = resolveGuidelines(
      deps.cwd,
      config.review.guidelinesRef,
      config.review.guidelinesDir,
      config.review.target,
      config.review.packs,
      config.review.frontmatterContract,
    );
    if (resolved.problems.length > 0) {
      return check(
        "guidelines",
        "fail",
        `${String(resolved.problems.length)} unusable file(s); run guidelines lint for the list`,
      );
    }
    if (resolved.guidelines.length === 0) {
      return check(
        "guidelines",
        "warn",
        `no guidelines in ${path.join(config.review.guidelinesDir)}; add one or run init`,
      );
    }
    return check(
      "guidelines",
      "ok",
      `${String(resolved.guidelines.length)} usable guideline(s) from ${resolved.origin}`,
    );
  } catch (error) {
    return check("guidelines", "fail", String((error as Error).message.split("\n")[0]));
  }
}

function checkModel(config: Config, credentials: Credentials): CheckResult {
  if (config.model.id === undefined) {
    return check("model", "warn", "model.id is not set yet; reviews need it (see the config spec)");
  }
  const credentialName: Record<string, keyof Credentials> = {
    anthropic: "ANTHROPIC_API_KEY",
    bedrock: "AWS_ACCESS_KEY_ID",
    openrouter: "OPENROUTER_API_KEY",
    "openai-compatible": "OPENAI_API_KEY",
  };
  const wanted = credentialName[config.model.provider];
  if (wanted !== undefined && (credentials[wanted] === undefined || credentials[wanted] === "")) {
    // local openai-compatible hosts accept any key, so absence is only a hint
    if (config.model.provider === "openai-compatible") {
      return check(
        "model",
        "warn",
        "OPENAI_API_KEY is not set; fine for local hosts, hosted ones will reject calls",
      );
    }
    return check(
      "model",
      "fail",
      `${wanted} is not set; the ${config.model.provider} provider needs it`,
    );
  }
  return check(
    "model",
    "ok",
    `${config.model.provider} / ${config.model.id} with credentials present`,
  );
}

async function checkScm(deps: RuntimeDeps, config: Config): Promise<CheckResult> {
  if (config.scm.provider === "local") {
    return check("scm", "ok", "local mode; nothing will be posted, checks skipped");
  }
  try {
    const scm = deps.scmPort ?? buildScmPort(config, loadCredentials(deps.env));
    await scm.listSummaryComments(); // read-only probe
    return check(
      "scm",
      "ok",
      `${config.scm.provider} reachable for ${config.scm.repository ?? ""}`,
    );
  } catch (error) {
    return check("scm", "fail", String((error as Error).message.split("\n")[0]));
  }
}

/** Validates an installation end to end without reviewing or posting anything. */
export async function runDoctor(
  deps: RuntimeDeps,
  flags: Readonly<Record<string, string>>,
): Promise<number> {
  const results: CheckResult[] = [];
  let config: Config | undefined;
  try {
    config = loadConfig({ root: deps.cwd, env: deps.env, flags });
    results.push(check("config", "ok", "configuration resolves and validates"));
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    results.push(check("config", "fail", error.problems.join("; ")));
  }

  if (config !== undefined) {
    results.push(checkGit(deps, config));
    results.push(checkGuidelines(deps, config));
    results.push(checkModel(config, loadCredentials(deps.env)));
    results.push(await checkScm(deps, config));
  } else {
    results.push(check("everything else", "warn", "skipped until the configuration resolves"));
  }

  const badge: Record<CheckLevel, string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };
  for (const result of results) {
    deps.out(`${badge[result.level]}  ${result.name}: ${result.detail}\n`);
  }
  const failures = results.filter((result) => result.level === "fail").length;
  if (failures > 0) {
    deps.err(`doctor found ${String(failures)} problem(s)\n`);
    return 1;
  }
  deps.out("doctor: all checks passed\n");
  return 0;
}
