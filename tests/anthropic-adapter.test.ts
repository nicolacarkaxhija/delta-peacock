import { describe, expect, it } from "vitest";
import { createAnthropicPort } from "../src/model/anthropic.js";

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
