import { describe, expect, it, vi } from "vitest";
import { ModelSchema } from "../src/config/schema.js";
import { buildModelPortFor } from "../src/model/build.js";
import { createBedrockPort } from "../src/model/bedrock.js";
import { DEFAULT_OMIT_TEMPERATURE_FOR, omitsTemperature } from "../src/model/generate.js";

const canned = {
  output: { message: { role: "assistant", content: [{ text: "{}" }] } },
  stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};

function capture(): { bodies: Record<string, unknown>[]; fetch: typeof globalThis.fetch } {
  const bodies: Record<string, unknown>[] = [];
  return {
    bodies,
    fetch: (_input, init) => {
      bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      return Promise.resolve(
        new Response(JSON.stringify(canned), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  };
}

async function sentTemperature(
  modelId: string,
  extra: { omitTemperatureFor?: readonly string[]; temperature?: number } = {},
): Promise<unknown> {
  const { bodies, fetch } = capture();
  const port = createBedrockPort({
    region: "eu-central-1",
    accessKeyId: "AKIA_TEST",
    secretAccessKey: "secret",
    modelId,
    fetch,
    ...(extra.omitTemperatureFor !== undefined
      ? { omitTemperatureFor: extra.omitTemperatureFor }
      : {}),
  });
  await port.complete({
    system: "s",
    user: "u",
    ...(extra.temperature !== undefined ? { temperature: extra.temperature } : {}),
  });
  const inference = bodies[0]?.["inferenceConfig"] as Record<string, unknown> | undefined;
  return inference?.["temperature"];
}

describe("temperature policy", () => {
  it("omits temperature for haiku 5.5 by default", async () => {
    expect(await sentTemperature("eu.anthropic.claude-haiku-5-5")).toBeUndefined();
  });

  it("omits it even when the request asks for one", async () => {
    expect(
      await sentTemperature("eu.anthropic.claude-haiku-5-5", { temperature: 0.3 }),
    ).toBeUndefined();
  });

  it("still pins other models to zero", async () => {
    expect(await sentTemperature("eu.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(0);
  });

  it("honors a configured list", async () => {
    expect(
      await sentTemperature("anthropic.claude-test", { omitTemperatureFor: ["claude-test"] }),
    ).toBeUndefined();
  });

  it("sends temperature for haiku 5.5 when the list is emptied", async () => {
    expect(await sentTemperature("eu.anthropic.claude-haiku-5-5", { omitTemperatureFor: [] })).toBe(
      0,
    );
  });

  it("matches ids case-insensitively as substrings", () => {
    expect(
      omitsTemperature("EU.Anthropic.Claude-Haiku-5-5-v1:0", DEFAULT_OMIT_TEMPERATURE_FOR),
    ).toBe(true);
    expect(omitsTemperature("claude-sonnet-4-5", DEFAULT_OMIT_TEMPERATURE_FOR)).toBe(false);
  });

  it("defaults the config list to haiku 5.5 and accepts an override", () => {
    expect(ModelSchema.parse({}).omitTemperatureFor).toEqual(["haiku-5-5"]);
    expect(ModelSchema.parse({ omitTemperatureFor: ["x"] }).omitTemperatureFor).toEqual(["x"]);
  });

  it("passes the list through the port builder", async () => {
    const { bodies, fetch } = capture();
    const credentials = {
      AWS_REGION: "eu-central-1",
      AWS_ACCESS_KEY_ID: "a",
      AWS_SECRET_ACCESS_KEY: "b",
    };
    vi.stubGlobal("fetch", fetch);
    const port = buildModelPortFor(
      { provider: "bedrock", id: "anthropic.claude-test", omitTemperatureFor: ["claude-test"] },
      credentials,
    );
    await port.complete({ system: "s", user: "u" });
    vi.unstubAllGlobals();
    const inference = bodies[0]?.["inferenceConfig"] as Record<string, unknown>;
    expect(inference["temperature"]).toBeUndefined();
  });
});
