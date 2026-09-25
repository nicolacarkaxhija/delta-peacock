import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseReviewResponse } from "../src/review/parse.js";
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

  it("pins temperature to zero by default and honors an override", async () => {
    const first = capturingFetch(canned);
    const port = createOpenAiishPort({
      apiKey: "test-key",
      modelId: "test-model",
      baseUrl: "https://example.test/v1",
      fetch: first.fetch,
    });
    await port.complete({ system: "sys", user: "usr" });
    expect(first.calls[0]?.body["temperature"]).toBe(0);

    const second = capturingFetch(canned);
    const warm = createOpenAiishPort({
      apiKey: "test-key",
      modelId: "test-model",
      baseUrl: "https://example.test/v1",
      fetch: second.fetch,
    });
    await warm.complete({ system: "sys", user: "usr", temperature: 0.7 });
    expect(second.calls[0]?.body["temperature"]).toBe(0.7);
  });

  it("bounds the reply with a default output token cap", async () => {
    const { calls, fetch } = capturingFetch(canned);
    const port = createOpenAiishPort({
      apiKey: "test-key",
      modelId: "test-model",
      baseUrl: "https://example.test/v1",
      fetch,
    });
    await port.complete({ system: "sys", user: "usr" });
    expect(calls[0]?.body["max_tokens"]).toBe(4000);
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

describe("tool passthrough on the other adapters", () => {
  it("openai-compatible forwards tools", async () => {
    const canned = {
      id: "c",
      object: "chat.completion",
      created: 1,
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const { calls, fetch } = capturingFetch(canned);
    const { tool } = await import("ai");
    const { z } = await import("zod");
    const port = createOpenAiishPort({
      apiKey: "k",
      modelId: "m",
      baseUrl: "https://x.test/v1",
      fetch,
    });
    await port.complete({
      system: "s",
      user: "u",
      tools: {
        ping: tool({
          description: "answers pong",
          inputSchema: z.object({}),
          execute: () => Promise.resolve("pong"),
        }),
      },
      // no maxToolRounds: the adapter's default bound applies
    });
    expect(JSON.stringify(calls[0]?.body["tools"])).toContain("ping");
  });

  it("bedrock forwards tools in its tool config", async () => {
    const canned = {
      output: { message: { role: "assistant", content: [{ text: "ok" }] } },
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
    const { calls, fetch } = capturingFetch(canned);
    const { tool } = await import("ai");
    const { z } = await import("zod");
    const port = createBedrockPort({
      region: "eu-central-1",
      accessKeyId: "k",
      secretAccessKey: "s",
      modelId: "anthropic.claude-test",
      fetch,
    });
    await port.complete({
      system: "s",
      user: "u",
      tools: {
        ping: tool({
          description: "answers pong",
          inputSchema: z.object({}),
          execute: () => Promise.resolve("pong"),
        }),
      },
    });
    expect(JSON.stringify(calls[0]?.body)).toContain("ping");
  });
});

describe("agentic tool budget (captured Haiku reply, a real Bitbucket pull request)", () => {
  // six steps, every one a tool call with prose around it and no JSON answer
  const captured = JSON.parse(
    readFileSync(
      new URL("./fixtures/replies/haiku-tool-budget-spent.json", import.meta.url),
      "utf8",
    ),
  ) as { finishReason: string; steps: { text: string; toolCalls: string[] }[] };
  const answer = JSON.stringify({ findings: [{ guidelineId: "g", file: "a.ts", line: 8 }] });

  function budgetFetch(): { bodies: Record<string, unknown>[]; fetch: typeof globalThis.fetch } {
    const bodies: Record<string, unknown>[] = [];
    return {
      bodies,
      fetch: (_input, init) => {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        bodies.push(body);
        const toolsOn = body["toolConfig"] !== undefined;
        const step = captured.steps[Math.min(bodies.length - 1, captured.steps.length - 1)];
        // the model keeps calling tools for as long as it is offered any
        const content = toolsOn
          ? [
              { text: step?.text ?? "" },
              { toolUse: { toolUseId: `t${String(bodies.length)}`, name: "ping", input: {} } },
            ]
          : [{ text: answer }];
        return Promise.resolve(
          new Response(
            JSON.stringify({
              output: { message: { role: "assistant", content } },
              stopReason: toolsOn ? "tool_use" : "end_turn",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      },
    };
  }

  it("the captured final step holds no JSON, which is what 0.1.3 failed on", () => {
    expect(captured.finishReason).toBe("tool-calls");
    const last = captured.steps.at(-1)?.text ?? "";
    expect(() =>
      parseReviewResponse(last, {
        guidelinesById: new Map(),
        generalPass: false,
        observationSeverityCap: "MINOR",
      }),
    ).toThrow("held no JSON object");
  });

  it("forces one answering step with tools off once the rounds are spent", async () => {
    const { bodies, fetch } = budgetFetch();
    const { tool } = await import("ai");
    const { z } = await import("zod");
    const port = createBedrockPort({
      region: "eu-central-1",
      accessKeyId: "k",
      secretAccessKey: "s",
      modelId: "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
      fetch,
    });
    const reply = await port.complete({
      system: "s",
      user: "u",
      tools: {
        ping: tool({
          description: "answers pong",
          inputSchema: z.object({}),
          execute: () => Promise.resolve("pong"),
        }),
      },
      maxToolRounds: 6,
    });
    expect(bodies).toHaveLength(7);
    expect(bodies[6]?.["toolConfig"]).toBeUndefined();
    expect(JSON.stringify(bodies[6]?.["system"])).toContain("tool budget is spent");
    expect(reply.toolCalls).toBe(6);
    expect(reply.text).toBe(answer);
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
      buildModelPort(config({ DELTA_PEACOCK_MODEL_PROVIDER: provider, ...env }), env),
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
    const built = buildModelPort(config({ DELTA_PEACOCK_MODEL_PROVIDER: provider, ...env }), env);
    expect(typeof built.complete).toBe("function");
  });

  it("openai-compatible defaults to a placeholder key for local hosts", () => {
    const built = buildModelPort(
      config({
        DELTA_PEACOCK_MODEL_PROVIDER: "openai-compatible",
        DELTA_PEACOCK_MODEL_BASE_URL: "http://localhost:11434/v1",
      }),
      {},
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
      env,
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
      { OPENROUTER_API_KEY: "k" },
    );
    expect(typeof openrouter.complete).toBe("function");
    const compatible = buildModelPort(
      config({
        DELTA_PEACOCK_MODEL_PROVIDER: "openai-compatible",
        DELTA_PEACOCK_MODEL_BASE_URL: "http://llm.local/v1",
      }),
      { OPENAI_API_KEY: "real-key" },
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
