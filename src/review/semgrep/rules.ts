import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Guideline, SemgrepCheck } from "../../domain/guideline.js";
import { quotesGuideline } from "../parse.js";

const SUFFIX = ".semgrep.yaml";

/** The metadata key a pack rule names its guideline set version under. */
const VERSION_KEY = "guidelines-version";

const KEYS = new Set(["type", "files", "message"]);

/** The rule file that sits next to a guideline file. */
export function rulesFileOf(guidelinePath: string): string {
  return guidelinePath.replace(/\.md$/, SUFFIX);
}

/** The rule file next to a guideline, read by the guideline set's own reader. */
export interface RuleSource {
  /** The rule file's name, for the problem that says it is missing. */
  name: string;
  /** The rule file's text; absent when there is none. */
  text?: string;
  /** The guideline set version the rules must carry; absent outside a pack. */
  version?: string;
}

type Rule = Record<string, unknown>;

/** The rules of a rule file, or why it holds none. */
function rulesIn(text: string): Rule[] | string {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    return `rule file is not valid YAML: ${String((error as Error).message.split("\n")[0])}`;
  }
  const rules = (parsed as { rules?: unknown } | null)?.rules;
  if (!Array.isArray(rules) || rules.length === 0) return "rule file holds no rules";
  return rules as Rule[];
}

const isMapping = (value: unknown): value is Rule =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Each rule says the guideline sentence and, in a pack, the set version; the first breach found. */
function ruleProblem(
  rules: readonly Rule[],
  message: string,
  version?: string,
): string | undefined {
  for (const [index, rule] of rules.entries()) {
    const id = isMapping(rule) ? rule["id"] : undefined;
    if (typeof id !== "string" || id === "") return `rule ${String(index + 1)} has no id`;
    if (rule["message"] !== message) {
      return `rule "${id}": "message" must be the guideline sentence "${message}"`;
    }
    if (version === undefined) continue;
    const metadata = rule["metadata"];
    const carried = isMapping(metadata) ? metadata[VERSION_KEY] : undefined;
    if (carried !== version) {
      return `rule "${id}" carries ${VERSION_KEY} ${typeof carried === "string" ? carried : "none"}; the guideline set is ${version}`;
    }
  }
  return undefined;
}

/**
 * Reads a `check:` of type semgrep with the rule file next to its guideline,
 * or says why it cannot run: its shape, the rule file, a rule message that is
 * not the guideline sentence, or a rule derived from another set version.
 */
export function readSemgrepCheck(
  record: Readonly<Record<string, unknown>>,
  guideline: Pick<Guideline, "id" | "title" | "body">,
  source: RuleSource,
): SemgrepCheck | string {
  const where = `guideline "${guideline.id}" check`;
  const unknown = Object.keys(record).filter((key) => !KEYS.has(key));
  if (unknown.length > 0) return `${where}: unknown key(s) ${unknown.join(", ")}`;
  const files = record["files"] ?? [];
  if (!(Array.isArray(files) && files.every((glob) => typeof glob === "string" && glob !== ""))) {
    return `${where}: "files" must be a list of path globs`;
  }
  const message = record["message"];
  if (typeof message !== "string" || message === "") return `${where}: "message" is needed`;
  if (!quotesGuideline(message, guideline)) {
    return `${where}: "message" must be a sentence the guideline says word for word`;
  }
  if (source.text === undefined) {
    return `${where}: type semgrep needs the rule file ${source.name} next to the guideline`;
  }
  const rules = rulesIn(source.text);
  if (typeof rules === "string") return `${where}: ${rules}`;
  const problem = ruleProblem(rules, message, source.version);
  if (problem !== undefined) return `${where}: ${problem}`;
  return {
    type: "semgrep",
    files: files as string[],
    rules: source.text,
    ...(source.version !== undefined ? { version: source.version } : {}),
    message,
  };
}

/** Which guideline and rule a combined rule id stands for. */
export interface RuleOwner {
  guideline: Guideline;
  rule: string;
}

/** Every guideline's rules in one config, each id prefixed with its guideline id. */
export function combinedRules(guidelines: readonly Guideline[]): {
  config: string;
  owners: Map<string, RuleOwner>;
} {
  const owners = new Map<string, RuleOwner>();
  const rules: Rule[] = [];
  for (const guideline of guidelines) {
    if (guideline.check?.type !== "semgrep") continue;
    // the loader checked the shape, so every entry is a rule with an id
    for (const rule of rulesIn(guideline.check.rules) as Rule[]) {
      const id = `${guideline.id}.${String(rule["id"])}`;
      owners.set(id, { guideline, rule: String(rule["id"]) });
      rules.push({ ...rule, id });
    }
  }
  return { config: stringifyYaml({ rules }), owners };
}
