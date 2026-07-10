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
  DELTA_PEACOCK_GATE_FAIL_ON: "gate.failOn",
  DELTA_PEACOCK_OUTPUT_REPORT: "output.report",
};

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

function readFileLayer(root: string): Record<string, unknown> {
  const filePath = path.join(root, CONFIG_FILE_NAME);
  if (!existsSync(filePath)) return {};
  const parsed: unknown = parseYaml(readFileSync(filePath, "utf8")) ?? {};
  if (!isPlainObject(parsed)) {
    throw new ConfigError([`${CONFIG_FILE_NAME} must hold a mapping of settings`]);
  }
  const credentialKeys = findCredentialKeys(parsed);
  if (credentialKeys.length > 0) {
    throw new ConfigError(
      credentialKeys.map(
        (key) =>
          `${key}: credentials do not belong in the config file; use environment variables instead`,
      ),
    );
  }
  return parsed;
}

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const root = options.root ?? process.cwd();
  const env = options.env ?? {};
  const flags = options.flags ?? {};

  const envLayer: Record<string, unknown> = {};
  for (const [name, dotPath] of Object.entries(ENV_VARS)) {
    const value = env[name];
    if (value !== undefined && value !== "") setPath(envLayer, dotPath, value);
  }

  const flagsLayer: Record<string, unknown> = {};
  for (const [dotPath, value] of Object.entries(flags)) {
    setPath(flagsLayer, dotPath, value);
  }

  const merged = mergeDeep(mergeDeep(readFileLayer(root), envLayer), flagsLayer);
  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => {
        const where = issue.path.join(".") || "config";
        return `${where}: ${issue.message}`;
      }),
    );
  }
  return deepFreeze(result.data);
}
