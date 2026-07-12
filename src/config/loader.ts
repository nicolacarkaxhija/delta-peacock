import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parse as parseYaml } from "yaml";
import { ConfigSchema, type Config } from "./schema.js";

export const CONFIG_FILE_NAME = "delta-peacock.config.yaml";

/** Every leaf setting is reachable through exactly one environment variable. */
export const ENV_VARS: Readonly<Record<string, string>> = {
  DELTA_PEACOCK_MODEL_PROVIDER: "model.provider",
  DELTA_PEACOCK_MODEL_ID: "model.id",
  DELTA_PEACOCK_MODEL_BASE_URL: "model.baseUrl",
  DELTA_PEACOCK_REVIEW_TARGET: "review.target",
  DELTA_PEACOCK_REVIEW_GUIDELINES_DIR: "review.guidelinesDir",
  DELTA_PEACOCK_REVIEW_GUIDELINES_REF: "review.guidelinesRef",
  DELTA_PEACOCK_REVIEW_FETCH_TARGET: "review.fetchTarget",
  DELTA_PEACOCK_REVIEW_LAST_REVIEWED_COMMIT: "review.lastReviewedCommit",
  DELTA_PEACOCK_REVIEW_INCLUDE: "review.include",
  DELTA_PEACOCK_REVIEW_EXCLUDE: "review.exclude",
  DELTA_PEACOCK_REVIEW_MAX_DIFF_BYTES: "review.maxDiffBytes",
  DELTA_PEACOCK_REVIEW_CONFIDENCE_FLOOR: "review.confidenceFloor",
  DELTA_PEACOCK_REVIEW_GENERAL_PASS: "review.generalPass",
  DELTA_PEACOCK_REVIEW_OBSERVATION_SEVERITY_CAP: "review.observationSeverityCap",
  DELTA_PEACOCK_REVIEW_MAX_PROPOSED_GUIDELINES: "review.maxProposedGuidelines",
  DELTA_PEACOCK_GATE_FAIL_ON: "gate.failOn",
  DELTA_PEACOCK_OUTPUT_REPORT: "output.report",
  DELTA_PEACOCK_REDACTION_PATTERNS: "redaction.patterns",
  DELTA_PEACOCK_SCM_PROVIDER: "scm.provider",
  DELTA_PEACOCK_SCM_REPOSITORY: "scm.repository",
  DELTA_PEACOCK_SCM_PULL_REQUEST: "scm.pullRequest",
  DELTA_PEACOCK_SCM_COMMIT_STATUS: "scm.commitStatus",
  DELTA_PEACOCK_SCM_BASE_URL: "scm.baseUrl",
  DELTA_PEACOCK_SCM_DRY_RUN: "scm.dryRun",
};

/** String sources (env, flags) coerce into these shapes before validation. */
const ARRAY_PATHS = new Set(["review.include", "review.exclude"]);
const NUMBER_PATHS = new Set([
  "review.maxDiffBytes",
  "review.confidenceFloor",
  "review.maxProposedGuidelines",
  "scm.pullRequest",
]);
const BOOLEAN_PATHS = new Set([
  "review.fetchTarget",
  "review.generalPass",
  "scm.commitStatus",
  "scm.dryRun",
]);
const JSON_PATHS = new Set(["redaction.patterns"]);

function coerceStringValue(dotPath: string, raw: string): unknown {
  if (JSON_PATHS.has(dotPath)) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  if (ARRAY_PATHS.has(dotPath)) {
    return raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "");
  }
  if (NUMBER_PATHS.has(dotPath)) {
    const parsed = Number(raw);
    return Number.isNaN(parsed) ? raw : parsed;
  }
  if (BOOLEAN_PATHS.has(dotPath)) {
    if (raw === "true") return true;
    if (raw === "false") return false;
    return raw;
  }
  return raw;
}

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`invalid configuration:\n${problems.join("\n")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export interface LoadConfigOptions {
  /** Directory holding the config file. Defaults to the working directory. */
  root?: string;
  /** Environment to read overrides from. Deliberately explicit; pass process.env at the edge. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Highest-precedence overrides as dot-path keys, e.g. { "gate.failOn": "MAJOR" }. */
  flags?: Readonly<Record<string, string>>;
}

const CREDENTIAL_SHAPES = [
  "key",
  "apikey",
  "accesskey",
  "secretkey",
  "token",
  "accesstoken",
  "secret",
  "password",
  "credential",
  "credentials",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeCredential(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll(/[-_]/g, "");
  return CREDENTIAL_SHAPES.some((shape) => normalized === shape || normalized.endsWith(shape));
}

function findCredentialKeys(value: unknown, trail: string[] = []): string[] {
  if (!isPlainObject(value)) return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const childTrail = [...trail, key];
    if (looksLikeCredential(key)) found.push(childTrail.join("."));
    found.push(...findCredentialKeys(child, childTrail));
  }
  return found;
}

function setPath(target: Record<string, unknown>, dotPath: string, value: unknown): void {
  const segments = dotPath.split(".");
  let cursor = target;
  segments.forEach((segment, position) => {
    if (position === segments.length - 1) {
      cursor[segment] = value;
      return;
    }
    const next = cursor[segment];
    if (isPlainObject(next)) {
      cursor = next;
    } else {
      const created: Record<string, unknown> = {};
      cursor[segment] = created;
      cursor = created;
    }
  });
}

function mergeDeep(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = merged[key];
    merged[key] =
      isPlainObject(existing) && isPlainObject(value) ? mergeDeep(existing, value) : value;
  }
  return merged;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function readFileLayer(root: string): { layer: Record<string, unknown>; problems: string[] } {
  const filePath = path.join(root, CONFIG_FILE_NAME);
  if (!existsSync(filePath)) return { layer: {}, problems: [] };
  const parsed: unknown = parseYaml(readFileSync(filePath, "utf8")) ?? {};
  if (!isPlainObject(parsed)) {
    throw new ConfigError([`${CONFIG_FILE_NAME} must hold a mapping of settings`]);
  }
  return {
    layer: parsed,
    problems: findCredentialKeys(parsed).map(
      (key) =>
        `${key}: credentials do not belong in the config file; use environment variables instead`,
    ),
  };
}

/** Keys already flagged as credentials should not be re-reported as merely unknown. */
function describeIssue(
  issue: { code: string; path: PropertyKey[]; message: string; keys?: string[] },
  flaggedKeys: ReadonlySet<string>,
): string | undefined {
  if (issue.code === "unrecognized_keys" && issue.keys !== undefined) {
    const kept = issue.keys.filter((key) => !flaggedKeys.has(key));
    if (kept.length === 0) return undefined;
    const where = issue.path.length > 0 ? issue.path.join(".") : "config";
    return `${where}: unrecognized key(s): ${kept.join(", ")}`;
  }
  const where = issue.path.length > 0 ? issue.path.join(".") : "config";
  return `${where}: ${issue.message}`;
}

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const root = options.root ?? process.cwd();
  const env = options.env ?? {};
  const flags = options.flags ?? {};

  const envLayer: Record<string, unknown> = {};
  for (const [name, dotPath] of Object.entries(ENV_VARS)) {
    const value = env[name];
    if (value !== undefined && value !== "") {
      setPath(envLayer, dotPath, coerceStringValue(dotPath, value));
    }
  }

  const flagsLayer: Record<string, unknown> = {};
  for (const [dotPath, value] of Object.entries(flags)) {
    setPath(flagsLayer, dotPath, coerceStringValue(dotPath, value));
  }

  const file = readFileLayer(root);
  const problems = [...file.problems];
  const flaggedKeys = new Set(
    file.problems.map((problem) => problem.split(":")[0]?.split(".").at(-1) ?? ""),
  );

  const merged = mergeDeep(mergeDeep(file.layer, envLayer), flagsLayer);
  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const described = describeIssue(issue, flaggedKeys);
      if (described !== undefined) problems.push(described);
    }
    // problems cannot be empty here: dedupe only removes keys the credential
    // guard already reported, so either list contributes at least one entry
    throw new ConfigError(problems);
  }
  if (problems.length > 0) {
    throw new ConfigError(problems);
  }
  return deepFreeze(result.data);
}
