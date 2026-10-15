import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAnthropicPort } from "../src/model/anthropic.js";
import type { ModelReply } from "../src/model/port.js";

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function cannedAnthropicResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 120, output_tokens: 34 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("anthropic adapter contract", () => {
  it("shapes the request for the messages API and maps the reply", async () => {
    const captured: CapturedRequest[] = [];
    const fakeFetch: typeof globalThis.fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      captured.push({
        url,
        headers: Object.fromEntries(headers.entries()),
        body: JSON.parse(init?.body as string) as Record<string, unknown>,
      });
      return Promise.resolve(cannedAnthropicResponse('{"findings": []}'));
    };

    const port = createAnthropicPort({
      apiKey: "test-key",
      modelId: "claude-test",
      fetch: fakeFetch,
    });
    const reply = await port.complete({ system: "system text", user: "user text" });

    expect(captured).toHaveLength(1);
    const request = captured[0];
    expect(request?.url).toContain("anthropic.com");
    expect(request?.url).toContain("/messages");
    expect(request?.headers["x-api-key"]).toBe("test-key");
    expect(request?.headers["anthropic-version"]).toBeDefined();
    expect(request?.body["model"]).toBe("claude-test");
    expect(JSON.stringify(request?.body["system"])).toContain("system text");
    expect(JSON.stringify(request?.body["messages"])).toContain("user text");

    expect(reply.text).toBe('{"findings": []}');
    expect(reply.usage).toMatchObject({ inputTokens: 120, outputTokens: 34 });
  });

  it("marks the stable prefix of the system prompt for the cache", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fakeFetch: typeof globalThis.fetch = (_input, init) => {
      bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      return Promise.resolve(cannedAnthropicResponse('{"findings": []}'));
    };
    const port = createAnthropicPort({ apiKey: "k", modelId: "claude-test", fetch: fakeFetch });
    await port.complete({ system: "guidelines\ncontext", user: "u", stablePrefix: 10 });
    expect(bodies[0]?.["system"]).toEqual([
      { type: "text", text: "guidelines", cache_control: { type: "ephemeral" } },
      { type: "text", text: "\ncontext" },
    ]);
  });

  it("sends one cached system block when the stable prefix is the whole prompt", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fakeFetch: typeof globalThis.fetch = (_input, init) => {
      bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      return Promise.resolve(cannedAnthropicResponse("{}"));
    };
    const port = createAnthropicPort({ apiKey: "k", modelId: "claude-test", fetch: fakeFetch });
    await port.complete({ system: "guidelines\n", user: "u", stablePrefix: 10 });
    expect(bodies[0]?.["system"]).toEqual([
      { type: "text", text: "guidelines", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("forwards context tools into the request body", async () => {
    const captured: CapturedRequest[] = [];
    const fakeFetch: typeof globalThis.fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      captured.push({
        url,
        headers: Object.fromEntries(headers.entries()),
        body: JSON.parse(init?.body as string) as Record<string, unknown>,
      });
      return Promise.resolve(cannedAnthropicResponse('{"findings": []}'));
    };
    const { tool } = await import("ai");
    const { z } = await import("zod");
    const port = createAnthropicPort({ apiKey: "k", modelId: "claude-test", fetch: fakeFetch });
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
    });
    expect(reply.text).toBe('{"findings": []}');
    expect(JSON.stringify(captured[0]?.body["tools"])).toContain("ping");
  });

  it("constructs without an injected fetch for production use", async () => {
    const { buildModelPort } = await import("../src/model/build.js");
    const { loadConfig } = await import("../src/config/loader.js");
    const config = loadConfig({
      env: { DELTA_PEACOCK_MODEL_ID: "claude-test" },
      root: process.cwd(),
    });
    const port = buildModelPort(config, { ANTHROPIC_API_KEY: "k" });
    expect(typeof port.complete).toBe("function");
  });

  it("surfaces API failures as errors", async () => {
    const failingFetch: typeof globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "authentication_error", message: "bad key" },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
      );
    const port = createAnthropicPort({
      apiKey: "bad",
      modelId: "claude-test",
      fetch: failingFetch,
    });
    await expect(port.complete({ system: "s", user: "u" })).rejects.toThrow();
  });
});

describe("a tool loop whose last step writes nothing", () => {
  const step = (content: unknown[], stop: string): Response =>
    new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content,
        stop_reason: stop,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const replies = [
    () =>
      step(
        [
          { type: "text", text: "partial answer" },
          { type: "tool_use", id: "call_1", name: "ping", input: {} },
        ],
        "tool_use",
      ),
    () => step([{ type: "text", text: " " }], "end_turn"),
  ];
  const run = async (): Promise<ModelReply> => {
    let call = 0;
    const port = createAnthropicPort({
      apiKey: "k",
      modelId: "claude-test",
      fetch: () => {
        const next = replies[call];
        call += 1;
        return Promise.resolve(next ? next() : step([], "end_turn"));
      },
    });
    return port.complete({
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
  };

  it("keeps the answer an earlier step wrote", async () => {
    const reply = await run();
    expect(reply.text).toContain("partial answer");
    expect(reply.usage).toMatchObject({ inputTokens: 20, outputTokens: 10 });
  });

  it("dumps every step as one JSON line when asked to", async () => {
    const target = path.join(mkdtempSync(path.join(tmpdir(), "dump-")), "replies.jsonl");
    process.env["DELTA_PEACOCK_DUMP_REPLY"] = target;
    try {
      await run();
    } finally {
      Reflect.deleteProperty(process.env, "DELTA_PEACOCK_DUMP_REPLY");
    }
    const line = JSON.parse(readFileSync(target, "utf8").trim()) as {
      steps: { toolCalls: string[]; text: string }[];
    };
    expect(line.steps.map((entry) => entry.toolCalls)).toEqual([["ping"], []]);
    expect(line.steps[0]?.text).toBe("partial answer");
  });
});
