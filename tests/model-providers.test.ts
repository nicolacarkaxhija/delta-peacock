import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/loader.js";
import { ToolError } from "../src/errors.js";
import { buildModelPort } from "../src/model/build.js";
import { createBedrockPort } from "../src/model/bedrock.js";
import { createOpenAiishPort } from "../src/model/openaiish.js";
import { addUsage, anyRateConfigured, computeCost } from "../src/model/usage.js";
import { makeRepo } from "./helpers/git.js";

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function capturingFetch(canned: unknown): { calls: Captured[]; fetch: typeof globalThis.fetch } {
  const calls: Captured[] = [];
  return {
    calls,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      calls.push({
        url,
        headers: Object.fromEntries(headers.entries()),
        body: JSON.parse(init?.body as string) as Record<string, unknown>,
      });
      return Promise.resolve(
        new Response(JSON.stringify(canned), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  };
}

describe("openai-compatible adapter contract", () => {
  const canned = {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: '{"findings": []}' },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 30 },
    },
  };

  it("speaks chat completions and maps usage with cache reads", async () => {
    const { calls, fetch } = capturingFetch(canned);
    const port = createOpenAiishPort({
      apiKey: "test-key",
      modelId: "test-model",
      baseUrl: "https://example.test/v1",
      fetch,
    });
    const reply = await port.complete({ system: "sys", user: "usr" });
    expect(calls[0]?.url).toContain("/chat/completions");
    expect(calls[0]?.headers["authorization"]).toBe("Bearer test-key");
    expect(calls[0]?.body["model"]).toBe("test-model");
    expect(JSON.stringify(calls[0]?.body["messages"])).toContain("usr");
    expect(reply.text).toBe('{"findings": []}');
    expect(reply.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
    });
  });
});

describe("bedrock adapter contract", () => {
  const canned = {
    output: { message: { role: "assistant", content: [{ text: '{"findings": []}' }] } },
    stopReason: "end_turn",
    usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
  };

  it("signs a converse request and maps the reply", async () => {
    const { calls, fetch } = capturingFetch(canned);
    const port = createBedrockPort({
      region: "eu-central-1",
      accessKeyId: "AKIA_TEST",
      secretAccessKey: "secret",
      modelId: "anthropic.claude-test",
      fetch,
    });
    const reply = await port.complete({ system: "sys", user: "usr" });
    expect(calls[0]?.url).toContain("anthropic.claude-test");
    expect(calls[0]?.url).toContain("converse");
    expect(calls[0]?.url).toContain("eu-central-1");
    expect(calls[0]?.headers["authorization"]).toContain("AWS4-HMAC-SHA256");
    expect(reply.text).toBe('{"findings": []}');
    expect(reply.usage).toMatchObject({ inputTokens: 50, outputTokens: 10 });
  });
});

describe("buildModelPort provider matrix", () => {
  function config(env: Record<string, string>) {
    return loadConfig({ root: makeRepo(), env: { DELTA_PEACOCK_MODEL_ID: "m", ...env } });
  }

  it.each([
    { provider: "openrouter", env: {}, missing: "OPENROUTER_API_KEY" },
    { provider: "bedrock", env: {}, missing: "AWS_REGION" },
    {
      provider: "bedrock",
      env: { AWS_REGION: "eu-central-1" },
      missing: "AWS_ACCESS_KEY_ID",
    },
    {
      provider: "bedrock",
      env: { AWS_REGION: "eu-central-1", AWS_ACCESS_KEY_ID: "k" },
      missing: "AWS_SECRET_ACCESS_KEY",
    },
  ])("$provider without credentials names $missing", ({ provider, env, missing }) => {
    expect(() =>
      buildModelPort(config({ DELTA_PEACOCK_MODEL_PROVIDER: provider, ...env }), {
        DELTA_PEACOCK_MODEL_PROVIDER: provider,
        DELTA_PEACOCK_MODEL_ID: "m",
        ...env,
      }),
    ).toThrow(missing);
  });

  it.each([
    { provider: "openrouter", env: { OPENROUTER_API_KEY: "k" } },
    {
      provider: "bedrock",
      env: {
        AWS_REGION: "eu-central-1",
        AWS_ACCESS_KEY_ID: "k",
        AWS_SECRET_ACCESS_KEY: "s",
        AWS_SESSION_TOKEN: "t",
      },
    },
  ])("$provider constructs with credentials", ({ provider, env }) => {
    const built = buildModelPort(config({ DELTA_PEACOCK_MODEL_PROVIDER: provider, ...env }), {
      DELTA_PEACOCK_MODEL_ID: "m",
      ...env,
    });
    expect(typeof built.complete).toBe("function");
  });

  it("openai-compatible defaults to a placeholder key for local hosts", () => {
    const built = buildModelPort(
      config({
        DELTA_PEACOCK_MODEL_PROVIDER: "openai-compatible",
        DELTA_PEACOCK_MODEL_BASE_URL: "http://localhost:11434/v1",
      }),
      {
        DELTA_PEACOCK_MODEL_ID: "m",
        DELTA_PEACOCK_MODEL_BASE_URL: "http://localhost:11434/v1",
      },
    );
    expect(typeof built.complete).toBe("function");
  });

  it("bedrock constructs without session token and with a base url override", () => {
    const env = {
      AWS_REGION: "eu-central-1",
      AWS_ACCESS_KEY_ID: "k",
      AWS_SECRET_ACCESS_KEY: "s",
    };
    const built = buildModelPort(
      config({
        DELTA_PEACOCK_MODEL_PROVIDER: "bedrock",
        DELTA_PEACOCK_MODEL_BASE_URL: "http://bedrock.local",
        ...env,
      }),
      { DELTA_PEACOCK_MODEL_ID: "m", ...env },
    );
    expect(typeof built.complete).toBe("function");
  });

  it("openrouter honors a base url override and openai-compatible uses a provided key", () => {
    const openrouter = buildModelPort(
      config({
        DELTA_PEACOCK_MODEL_PROVIDER: "openrouter",
        DELTA_PEACOCK_MODEL_BASE_URL: "http://router.local/v1",
        OPENROUTER_API_KEY: "k",
      }),
      { DELTA_PEACOCK_MODEL_ID: "m", OPENROUTER_API_KEY: "k" },
    );
    expect(typeof openrouter.complete).toBe("function");
    const compatible = buildModelPort(
      config({
        DELTA_PEACOCK_MODEL_PROVIDER: "openai-compatible",
        DELTA_PEACOCK_MODEL_BASE_URL: "http://llm.local/v1",
      }),
      { DELTA_PEACOCK_MODEL_ID: "m", OPENAI_API_KEY: "real-key" },
    );
    expect(typeof compatible.complete).toBe("function");
  });

  it("still requires a model id first", () => {
    expect(() => buildModelPort(loadConfig({ root: makeRepo() }), {})).toThrow(ToolError);
  });
});

describe("cost accounting", () => {
  const rates = {
    rateInputPer1M: 3,
    rateOutputPer1M: 15,
    rateCacheReadPer1M: 0.3,
    rateCacheWritePer1M: 3.75,
  };

  it("prices usage including cache reads and writes", () => {
    const cost = computeCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 200_000,
        cacheReadTokens: 500_000,
        cacheWriteTokens: 100_000,
      },
      rates,
    );
    expect(cost.input).toBeCloseTo(3);
    expect(cost.output).toBeCloseTo(3);
    expect(cost.cacheRead).toBeCloseTo(0.15);
    expect(cost.cacheWrite).toBeCloseTo(0.375);
    expect(cost.total).toBeCloseTo(6.525);
  });

  it("knows when no rate is configured", () => {
    expect(
      anyRateConfigured({
        rateInputPer1M: 0,
        rateOutputPer1M: 0,
        rateCacheReadPer1M: 0,
        rateCacheWritePer1M: 0,
      }),
    ).toBe(false);
    expect(anyRateConfigured(rates)).toBe(true);
  });

  it("prices usage that carries no cache counts", () => {
    const cost = computeCost({ inputTokens: 1_000_000, outputTokens: 0 }, rates);
    expect(cost.cacheRead).toBe(0);
    expect(cost.cacheWrite).toBe(0);
    expect(cost.total).toBeCloseTo(3);
  });

  it("adds usage when neither side carries cache counts", () => {
    expect(
      addUsage({ inputTokens: 1, outputTokens: 2 }, { inputTokens: 3, outputTokens: 4 }),
    ).toEqual({ inputTokens: 4, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it("adds usage across calls", () => {
    const sum = addUsage(
      { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 },
      { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 3 },
    );
    expect(sum).toEqual({
      inputTokens: 11,
      outputTokens: 6,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
    });
  });
});
