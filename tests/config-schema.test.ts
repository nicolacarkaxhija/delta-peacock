import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ENV_VARS } from "../src/config/loader.js";
import { ConfigSchema } from "../src/config/schema.js";

const jsonSchema = z.toJSONSchema(ConfigSchema, { io: "input" });

function leafPaths(node: unknown, trail: string[] = []): string[] {
  if (typeof node !== "object" || node === null) return [];
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
    expect(mapped.length).toBe(new Set(mapped).size);
  });

  it("prefixes every environment variable consistently", () => {
    for (const name of Object.keys(ENV_VARS)) {
      expect(name).toMatch(/^DELTA_PEACOCK_[A-Z_]+$/);
    }
  });
});
