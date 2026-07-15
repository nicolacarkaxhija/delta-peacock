import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ENV_VARS } from "../src/config/loader.js";
import { ConfigSchema } from "../src/config/schema.js";

const jsonSchema = {
  $id: "https://raw.githubusercontent.com/nicolacarkaxhija/delta-peacock/main/schema/delta-peacock.config.schema.json",
  ...z.toJSONSchema(ConfigSchema, { io: "input" }),
};

const mappedSubtrees = new Set(Object.values(ENV_VARS));

function leafPaths(node: unknown, trail: string[] = []): string[] {
  if (typeof node !== "object" || node === null) return [];
  // a whole subtree reachable through one env var (JSON-coerced) is a leaf
  if (trail.length > 0 && mappedSubtrees.has(trail.join("."))) return [trail.join(".")];
  const record = node as { properties?: Record<string, unknown> };
  if (!record.properties) return [trail.join(".")];
  return Object.entries(record.properties).flatMap(([key, child]) =>
    leafPaths(child, [...trail, key]),
  );
}

describe("config json schema", () => {
  it("stays in sync with the committed schema file", async () => {
    await expect(`${JSON.stringify(jsonSchema, null, 2)}\n`).toMatchFileSnapshot(
      "../schema/delta-peacock.config.schema.json",
    );
  });

  it("maps every leaf setting to exactly one environment variable", () => {
    const leaves = new Set(leafPaths(jsonSchema));
    const mapped = Object.values(ENV_VARS);
    expect(new Set(mapped)).toEqual(leaves);
    expect(mapped).toHaveLength(new Set(mapped).size);
  });

  it("prefixes every environment variable consistently", () => {
    for (const name of Object.keys(ENV_VARS)) {
      expect(name).toMatch(/^DELTA_PEACOCK_[A-Z0-9_]+$/);
    }
  });
});
