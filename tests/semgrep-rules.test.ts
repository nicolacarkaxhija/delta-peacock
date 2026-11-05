import { describe, expect, it } from "vitest";
import type { Guideline, SemgrepCheck } from "../src/domain/guideline.js";
import {
  loadGuidelinesFromFiles,
  readGitRefGuidelines,
  readWorkingTreeGuidelines,
} from "../src/guidelines/loader.js";
import { resolvePack } from "../src/guidelines/packs.js";
import { combinedRules, rulesFileOf } from "../src/review/semgrep/rules.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const SENTENCE = "A log call never chains on getLogger.";

const GUIDELINE = `---
id: logger-assigned-once
severity: MINOR
languages: [javascript]
paths: ["cartridges/**"]
check:
  type: semgrep
  files: ["cartridges/**/*.js"]
  message: ${SENTENCE}
---
# Assign the logger once

${SENTENCE} The logger is assigned once and every call goes through it.
`;

const rulesOf = (message: string, extra = ""): string => `rules:
  - id: chained-logger
    languages: [javascript]
    severity: WARNING
    message: ${message}
    pattern: $X.getLogger(...).$LEVEL(...)
${extra}`;

const RULES = rulesOf(SENTENCE);

const versioned = (version: string): string =>
  rulesOf(SENTENCE, `    metadata:\n      guidelines-version: "${version}"\n`);

function loadOne(content: string, semgrep?: string, version?: string) {
  return loadGuidelinesFromFiles([
    {
      displayPath: "guidelines/logger-assigned-once.md",
      content,
      ...(semgrep !== undefined ? { semgrep } : {}),
      ...(version !== undefined ? { version } : {}),
    },
  ]);
}

function semgrepCheckOf(guideline: Guideline | undefined): SemgrepCheck {
  const check = guideline?.check;
  if (check?.type !== "semgrep") throw new Error("no semgrep check");
  return check;
}

describe("rulesFileOf", () => {
  it("names the rule file next to the guideline", () => {
    expect(rulesFileOf("guidelines/sfra/logger.md")).toBe("guidelines/sfra/logger.semgrep.yaml");
  });
});

describe("a guideline that declares a semgrep check", () => {
  it("carries the rule file, its globs and the guideline sentence", () => {
    const loaded = loadOne(GUIDELINE, RULES);
    expect(loaded.problems).toEqual([]);
    const check = semgrepCheckOf(loaded.guidelines[0]);
    expect(check).toEqual({
      type: "semgrep",
      files: ["cartridges/**/*.js"],
      rules: RULES,
      message: SENTENCE,
    });
  });

  it("covers every file of the guideline when it names no globs", () => {
    const loaded = loadOne(GUIDELINE.replace('  files: ["cartridges/**/*.js"]\n', ""), RULES);
    expect(semgrepCheckOf(loaded.guidelines[0]).files).toEqual([]);
  });

  it("records the guideline set version every rule carries", () => {
    const loaded = loadOne(GUIDELINE, versioned("0.2.0"), "0.2.0");
    expect(loaded.problems).toEqual([]);
    expect(semgrepCheckOf(loaded.guidelines[0]).version).toBe("0.2.0");
  });

  const problems: {
    why: string;
    content?: string;
    rules?: string;
    version?: string;
    says: string;
  }[] = [
    { why: "no rule file", says: "needs the rule file logger-assigned-once.semgrep.yaml" },
    { why: "unreadable YAML", rules: "rules: [", says: "rule file is not valid YAML" },
    { why: "no rules list", rules: "rules: []\n", says: "rule file holds no rules" },
    {
      why: "a rule that is no mapping",
      rules: "rules:\n  - just text\n",
      says: "rule 1 has no id",
    },
    {
      why: "a rule with no id",
      rules: "rules:\n  - message: x\n",
      says: "rule 1 has no id",
    },
    {
      why: "a message the guideline does not say",
      rules: rulesOf("Something else."),
      says: `rule "chained-logger": "message" must be the guideline sentence "${SENTENCE}"`,
    },
    {
      why: "a rule set with no version in a versioned set",
      rules: RULES,
      version: "0.2.0",
      says: `rule "chained-logger" carries guidelines-version none; the guideline set is 0.2.0`,
    },
    {
      why: "a rule set derived from another version",
      rules: versioned("0.1.0"),
      version: "0.2.0",
      says: `rule "chained-logger" carries guidelines-version 0.1.0; the guideline set is 0.2.0`,
    },
    {
      why: "an unknown key",
      content: GUIDELINE.replace("  type: semgrep\n", "  type: semgrep\n  added: x\n"),
      rules: RULES,
      says: "unknown key(s) added",
    },
    {
      why: "globs that are no list",
      content: GUIDELINE.replace('["cartridges/**/*.js"]', "12"),
      rules: RULES,
      says: `"files" must be a list of path globs`,
    },
    {
      why: "no message",
      content: GUIDELINE.replace(`  message: ${SENTENCE}\n`, ""),
      rules: RULES,
      says: `"message" is needed`,
    },
    {
      why: "a message the guideline text does not hold",
      content: GUIDELINE.replace(`  message: ${SENTENCE}`, "  message: Not in the text."),
      rules: rulesOf("Not in the text."),
      says: `"message" must be a sentence the guideline says word for word`,
    },
  ];
  for (const row of problems) {
    it(`is skipped with its reason for ${row.why}`, () => {
      const loaded = loadOne(row.content ?? GUIDELINE, row.rules, row.version);
      expect(loaded.guidelines).toEqual([]);
      expect(loaded.problems).toHaveLength(1);
      expect(loaded.problems[0]).toContain(row.says);
    });
  }
});

describe("the guideline readers", () => {
  it("attach the rule file next to a working tree guideline", () => {
    const repo = makeRepo();
    write(repo, "guidelines/logger-assigned-once.md", GUIDELINE);
    write(repo, "guidelines/logger-assigned-once.semgrep.yaml", RULES);
    write(repo, "guidelines/plain.md", "---\nid: plain\nseverity: INFO\n---\n# Plain\n\nText.\n");
    const files = readWorkingTreeGuidelines(`${repo}/guidelines`);
    const byName = new Map(files.map((file) => [file.displayPath.split("/").pop(), file]));
    expect(byName.get("logger-assigned-once.md")?.semgrep).toBe(RULES);
    expect(byName.get("plain.md")?.semgrep).toBeUndefined();
  });

  it("attach the rule file a git ref holds next to its guideline", () => {
    const repo = makeRepo();
    write(repo, "guidelines/logger-assigned-once.md", GUIDELINE);
    write(repo, "guidelines/logger-assigned-once.semgrep.yaml", RULES);
    write(repo, "guidelines/plain.md", "---\nid: plain\nseverity: INFO\n---\n# Plain\n\nText.\n");
    commitAll(repo, "rules");
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "guidelines/logger-assigned-once.semgrep.yaml", rulesOf("Weakened."));
    commitAll(repo, "weaken");
    const files = readGitRefGuidelines(repo, "main", "guidelines") ?? [];
    const loaded = loadGuidelinesFromFiles(files);
    expect(loaded.problems).toEqual([]);
    expect(
      semgrepCheckOf(loaded.guidelines.find((one) => one.id === "logger-assigned-once")).rules,
    ).toBe(RULES);
  });

  it("attach a pack's rule files with the pack version", () => {
    const repo = makeRepo();
    write(repo, "pack/pack.yaml", "name: house\nversion: 0.2.0\n");
    write(repo, "pack/logger-assigned-once.md", GUIDELINE);
    write(repo, "pack/logger-assigned-once.semgrep.yaml", versioned("0.2.0"));
    const pack = resolvePack(repo, "pack");
    const loaded = loadGuidelinesFromFiles(pack.files);
    expect(loaded.problems).toEqual([]);
    expect(semgrepCheckOf(loaded.guidelines[0]).version).toBe("0.2.0");
  });
});

describe("combinedRules", () => {
  it("leaves out a guideline with no semgrep check", () => {
    const plain = loadGuidelinesFromFiles([
      {
        displayPath: "plain.md",
        content: "---\nid: plain\nseverity: INFO\n---\n# Plain\n\nText.\n",
      },
    ]).guidelines;
    const combined = combinedRules(plain);
    expect(combined.owners.size).toBe(0);
    expect(combined.config).toBe("rules: []\n");
  });

  it("joins every guideline's rules into one config whose ids name their guideline", () => {
    const first = loadOne(GUIDELINE, RULES).guidelines[0];
    const second = loadOne(
      GUIDELINE.replace("id: logger-assigned-once", "id: second"),
      `${RULES}  - id: other
    languages: [javascript]
    severity: WARNING
    message: ${SENTENCE}
    pattern: foo()
`,
    ).guidelines[0];
    if (first === undefined || second === undefined) throw new Error("not loaded");
    const combined = combinedRules([first, second]);
    expect(
      [...combined.owners.entries()].map(([id, owner]) => [id, owner.guideline.id, owner.rule]),
    ).toEqual([
      ["logger-assigned-once.chained-logger", "logger-assigned-once", "chained-logger"],
      ["second.chained-logger", "second", "chained-logger"],
      ["second.other", "second", "other"],
    ]);
    expect(combined.config).toContain("id: logger-assigned-once.chained-logger");
    expect(combined.config).toContain("pattern: foo()");
  });
});
