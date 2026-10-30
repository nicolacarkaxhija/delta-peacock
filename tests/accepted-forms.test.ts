import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Finding } from "../src/domain/finding.js";
import { ToolError } from "../src/errors.js";
import {
  ACCEPTED_FORMS_FILE,
  isAccepted,
  parseAcceptedForms,
  partitionAccepted,
  readAcceptedForms,
} from "../src/review/accepted-forms.js";
import { commitAll, makeRepo, write } from "./helpers/git.js";

function violation(title: string, extra: Partial<Finding> = {}): Finding {
  return {
    kind: "violation",
    guidelineId: "axis-tags",
    severity: "MINOR",
    file: "tests/notes.spec.ts",
    line: 3,
    title,
    body: "The config declares no such tag.",
    ...extra,
  };
}

const FORMS = parseAcceptedForms(
  JSON.stringify({
    tags: ["@not-env:prd", "@not-site:*", "@locale:*"],
    patterns: { "axis-tags": ["^Tag @device:desktop"] },
  }),
  "guidelines/accepted-forms.json",
);

describe("the accepted forms file", () => {
  it("defaults both lists to empty", () => {
    expect(parseAcceptedForms("{}", "f.json")).toEqual({ tags: [], patterns: {} });
  });

  it("refuses text that is not JSON, an unknown key, and a pattern that does not compile", () => {
    expect(() => parseAcceptedForms("{", "f.json")).toThrow(ToolError);
    expect(() => parseAcceptedForms('{"tag": []}', "f.json")).toThrow(/f\.json: /);
    expect(() => parseAcceptedForms('{"tags": ["notes"]}', "f.json")).toThrow(/tags\.0/);
    expect(() => parseAcceptedForms('{"patterns": {"a": ["("]}}', "f.json")).toThrow(
      /f\.json: patterns\.a: "\(" is not a valid regular expression/,
    );
  });
});

describe("a finding on an accepted form", () => {
  it("is accepted when every tag its title names is listed", () => {
    expect(isAccepted(violation("Undeclared tag @not-site:US"), FORMS)).toBe(true);
    expect(isAccepted(violation("Tags @locale:nl and @not-env:prd are unknown"), FORMS)).toBe(true);
  });

  it("is kept when its title names one tag the list lacks", () => {
    expect(isAccepted(violation("Tags @smoke and @locale:nl are unknown"), FORMS)).toBe(false);
    expect(isAccepted(violation("Undeclared tag @not-env:qa"), FORMS)).toBe(false);
    expect(isAccepted(violation("Undeclared tag @locale:nl:x"), FORMS)).toBe(false);
  });

  it("reads the body's tags only when the title names none", () => {
    expect(isAccepted(violation("Undeclared axis tag", { body: "@locale:nl" }), FORMS)).toBe(true);
    expect(isAccepted(violation("Undeclared tag @smoke", { body: "@locale:nl" }), FORMS)).toBe(
      false,
    );
    expect(isAccepted(violation("Wrong tag", { body: "no tag named" }), FORMS)).toBe(false);
  });

  it("is accepted by a pattern of its own guideline, matched on title, body or quote", () => {
    expect(isAccepted(violation("Tag @device:desktop narrows the run"), FORMS)).toBe(true);
    const other = violation("Tag @device:desktop narrows the run", { guidelineId: "other" });
    expect(isAccepted(other, FORMS)).toBe(false);
    const quoted = parseAcceptedForms(
      JSON.stringify({ patterns: { "axis-tags": ["hover"] } }),
      "f.json",
    );
    expect(isAccepted(violation("Narrow tag", { quote: "// hover only" }), quoted)).toBe(true);
    expect(isAccepted(violation("Narrow tag"), quoted)).toBe(false);
  });

  it("never accepts an observation by pattern, only by tag", () => {
    const observation: Finding = {
      kind: "observation",
      severity: "MINOR",
      file: "a.ts",
      line: 1,
      title: "Tag @device:desktop narrows the run",
      body: "",
    };
    expect(isAccepted(observation, FORMS)).toBe(false);
    expect(isAccepted({ ...observation, title: "Odd tag @locale:de" }, FORMS)).toBe(true);
  });

  it("splits findings into kept and accepted", () => {
    const kept = violation("Undeclared tag @smoke");
    const accepted = violation("Undeclared tag @not-site:US");
    expect(partitionAccepted([kept, accepted], FORMS)).toEqual({
      kept: [kept],
      accepted: [accepted],
    });
    expect(partitionAccepted([kept], undefined)).toEqual({ kept: [kept], accepted: [] });
  });
});

describe("reading the accepted forms", () => {
  const body = JSON.stringify({ tags: ["@locale:*"] });

  it("reads the guidelines folder on the ref the guidelines came from", () => {
    const repo = makeRepo();
    write(repo, `guidelines/${ACCEPTED_FORMS_FILE}`, body);
    commitAll(repo, "accepted forms");
    write(repo, `guidelines/${ACCEPTED_FORMS_FILE}`, "{}");
    expect(readAcceptedForms(repo, "HEAD", "./guidelines")?.tags).toEqual(["@locale:*"]);
    expect(readAcceptedForms(repo, "HEAD", "other")).toBeUndefined();
  });

  it("reads the working tree and a local folder from disk", () => {
    const repo = makeRepo();
    write(repo, `guidelines/${ACCEPTED_FORMS_FILE}`, body);
    expect(readAcceptedForms(repo, "working tree", "guidelines")?.tags).toEqual(["@locale:*"]);
    const local = path.join(repo, "elsewhere");
    mkdirSync(local);
    writeFileSync(path.join(local, ACCEPTED_FORMS_FILE), body);
    expect(readAcceptedForms(repo, `local:${local}`, "guidelines")?.tags).toEqual(["@locale:*"]);
    expect(readAcceptedForms(repo, "working tree", "missing")).toBeUndefined();
  });

  it("reads nothing when no local corpus judged the run", () => {
    const repo = makeRepo();
    write(repo, `guidelines/${ACCEPTED_FORMS_FILE}`, body);
    expect(readAcceptedForms(repo, "packs only", "guidelines")).toBeUndefined();
    expect(readAcceptedForms(repo, "none", "guidelines")).toBeUndefined();
  });

  it("names the file in a parse error", () => {
    const repo = makeRepo();
    write(repo, `guidelines/${ACCEPTED_FORMS_FILE}`, "{");
    expect(() => readAcceptedForms(repo, "working tree", "guidelines")).toThrow(
      /guidelines\/accepted-forms\.json: not valid JSON/,
    );
  });
});
