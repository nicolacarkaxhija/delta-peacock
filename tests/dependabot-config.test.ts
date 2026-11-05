import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface Update {
  "package-ecosystem": string;
  directory?: string;
  schedule: { interval: string };
  "commit-message": Record<string, string>;
  groups: Record<string, { "update-types": string[] }>;
  ignore?: { "dependency-name": string }[];
}

const config = parse(
  readFileSync(fileURLToPath(new URL("../.github/dependabot.yml", import.meta.url)), "utf8"),
) as { version: number; updates: Update[] };
const found = config.updates.find((update) => update["package-ecosystem"] === "npm");
if (found === undefined) throw new Error("no npm entry in .github/dependabot.yml");
const npm: Update = found;
const ignored = (npm.ignore ?? []).map((rule) => rule["dependency-name"]);

describe("the dependabot config", () => {
  it("uses the current config version and one npm entry at the root", () => {
    expect(config.version).toBe(2);
    expect(config.updates.filter((update) => update["package-ecosystem"] === "npm")).toHaveLength(
      1,
    );
    expect(npm.directory).toBe("/");
  });

  it("checks weekly", () => {
    expect(npm.schedule.interval).toBe("weekly");
  });

  it("writes commit subjects the commit hook accepts", () => {
    expect(npm["commit-message"]).toEqual({ prefix: "chore", include: "scope" });
  });

  it("groups minor and patch updates into one pull request and leaves majors out", () => {
    const groups = Object.values(npm.groups);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.["update-types"]).toEqual(["minor", "patch"]);
  });

  it.each(["playwright", "playwright-core", "@playwright/test"])(
    "ignores %s, which moves with the pinned image",
    (name) => {
      expect(ignored).toContain(name);
    },
  );
});
