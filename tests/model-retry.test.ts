import { APICallError, tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAnthropicPort } from "../src/model/anthropic.js";
import type { ModelPort, ModelReply, ModelRequest, ModelUsage } from "../src/model/port.js";
import {
  BACKOFF_BASE_MS,
  MODEL_ATTEMPTS,
  RETRY_AFTER_CAP_MS,
  backoffMs,
  retryAfterMs,
  retryable,
  withRetry,
} from "../src/model/retry.js";
import { SpentError, spentOf } from "../src/model/spent.js";
import { ModelUnavailableError, unavailability } from "../src/model/unavailable.js";

const apiError = (
  statusCode: number | undefined,
  message: string,
  cause?: unknown,
  responseHeaders?: Record<string, string>,
): APICallError =>
  new APICallError({
    message,
    url: "https://bedrock-runtime.example.com/model/m/converse",
    requestBodyValues: {},
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(cause !== undefined ? { cause } : {}),
    ...(responseHeaders !== undefined ? { responseHeaders } : {}),
  });

const serviceUnavailable = (): APICallError =>
  apiError(503, "Bedrock is unable to process your request.");
const throttled = (): APICallError => apiError(429, "Too many requests, please wait.");
const connectionRefused = (): APICallError =>
  apiError(
    undefined,
    "Cannot connect to API: fetch failed",
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }),
  );
const timedOut = (): Error =>
  Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
const forbidden = (): APICallError =>
  apiError(403, "The security token included in the request is invalid.");
const badRequest = (): APICallError => apiError(400, "messages: field required");

const ANSWER: ModelReply = { text: '{"findings": []}' };

/** A port that fails with the given errors in turn, then answers. */
function scripted(
  errors: readonly Error[],
  answer: ModelReply = ANSWER,
): { port: ModelPort; calls: () => number; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    calls: () => requests.length,
    requests,
    port: {
      complete: (request) => {
        const error = errors[requests.length];
        requests.push(request);
        return error === undefined ? Promise.resolve(answer) : Promise.reject(error);
      },
    },
  };
}

function recordingWait(): { wait: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
}

const REQUEST = { system: "s", user: "u" };

describe("which failures the model retry tries again", () => {
  it.each([
    ["a provider that cannot serve the request (503)", serviceUnavailable()],
    ["a throttled request (429)", throttled()],
    ["a refused connection", connectionRefused()],
    ["a timeout", timedOut()],
    ["an outage already classed", new ModelUnavailableError("unreachable", "model call failed")],
    ["a bare transport failure", { code: "ECONNRESET" }],
  ])("retries %s", (_, error) => {
    expect(retryable(error)).toBe(true);
  });

  it.each([
    ["a refused credential (403)", forbidden()],
    ["a rejected key (401)", apiError(401, "invalid x-api-key")],
    ["a malformed request (400)", badRequest()],
    ["an error with no transport cause", new Error("model replied with nothing")],
  ])("never retries %s", (_, error) => {
    expect(retryable(error)).toBe(false);
  });
});

describe("the backoff between attempts", () => {
  it("doubles from the base and keeps between half and all of it", () => {
    expect(backoffMs(1, () => 0)).toBe(BACKOFF_BASE_MS / 2);
    expect(backoffMs(1, () => 1)).toBe(BACKOFF_BASE_MS);
    expect(backoffMs(2, () => 0)).toBe(BACKOFF_BASE_MS);
    expect(backoffMs(2, () => 1)).toBe(BACKOFF_BASE_MS * 2);
    expect(backoffMs(2, () => 0.5)).toBe(BACKOFF_BASE_MS * 1.5);
  });
});

describe("a model behind the retry", () => {
  it("answers on the first attempt without waiting", async () => {
    const { port, calls } = scripted([]);
    const { wait, waits } = recordingWait();
    await expect(withRetry(port, { wait, random: () => 0 }).complete(REQUEST)).resolves.toBe(
      ANSWER,
    );
    expect(calls()).toBe(1);
    expect(waits).toEqual([]);
  });

  it("answers after outages within its attempts, backing off before each retry", async () => {
    const { port, calls } = scripted([serviceUnavailable(), throttled()]);
    const { wait, waits } = recordingWait();
    const reply = await withRetry(port, { wait, random: () => 1 }).complete(REQUEST);
    expect(reply).toBe(ANSWER);
    expect(calls()).toBe(MODEL_ATTEMPTS);
    expect(waits).toEqual([BACKOFF_BASE_MS, BACKOFF_BASE_MS * 2]);
  });

  it("gives up after its attempts with the last error, still classed as an outage", async () => {
    const { port, calls } = scripted([
      serviceUnavailable(),
      serviceUnavailable(),
      serviceUnavailable(),
      serviceUnavailable(),
    ]);
    const { wait, waits } = recordingWait();
    const failure = await withRetry(port, { wait, random: () => 0 })
      .complete(REQUEST)
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      );
    expect(calls()).toBe(MODEL_ATTEMPTS);
    expect(waits).toHaveLength(MODEL_ATTEMPTS - 1);
    expect(failure?.message).toBe(
      `${String(MODEL_ATTEMPTS)} attempts, the last: Bedrock is unable to process your request.`,
    );
    expect(unavailability(failure, "fallback")).toBe("unreachable");
  });

  it("rethrows a refused credential at once, untouched", async () => {
    const refused = forbidden();
    const { port, calls } = scripted([refused]);
    const { wait, waits } = recordingWait();
    await expect(withRetry(port, { wait }).complete(REQUEST)).rejects.toBe(refused);
    expect(calls()).toBe(1);
    expect(waits).toEqual([]);
  });

  it("waits on real timers by default", async () => {
    const { port, calls } = scripted([serviceUnavailable()]);
    const started = Date.now();
    await withRetry(port, { random: () => 0, baseMs: 20 }).complete(REQUEST);
    expect(calls()).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(9);
  });
});

describe("the wait a provider asks for", () => {
  const NOW = Date.parse("2026-10-14T10:00:00Z");
  const now = (): number => NOW;
  const asking = (headers: Record<string, string>): APICallError =>
    apiError(429, "Too many requests, please wait.", undefined, headers);

  it.each([
    ["milliseconds", { "retry-after-ms": "1500" }, 1500],
    ["seconds", { "retry-after": "7" }, 7000],
    ["fractional seconds", { "retry-after": "1.5" }, 1500],
    ["an HTTP date", { "retry-after": "Wed, 14 Oct 2026 10:00:30 GMT" }, 30_000],
    ["a header name in any case", { "Retry-After": "3" }, 3000],
    ["milliseconds before seconds", { "retry-after-ms": "250", "retry-after": "9" }, 250],
    [
      "seconds when the milliseconds are invalid",
      { "retry-after-ms": "x", "retry-after": "2" },
      2000,
    ],
    ["no more than the cap in seconds", { "retry-after": "3600" }, RETRY_AFTER_CAP_MS],
    ["no more than the cap in milliseconds", { "retry-after-ms": "999999" }, RETRY_AFTER_CAP_MS],
    [
      "no more than the cap as a date",
      { "retry-after": "Wed, 14 Oct 2026 11:00:00 GMT" },
      RETRY_AFTER_CAP_MS,
    ],
  ])("honours %s", (_, headers, expected) => {
    expect(retryAfterMs(asking(headers), now)).toBe(expected);
  });

  it.each([
    ["no header", {}],
    ["a word", { "retry-after": "soon" }],
    ["negative seconds", { "retry-after": "-5" }],
    ["negative milliseconds", { "retry-after-ms": "-1" }],
    ["a date already past", { "retry-after": "Wed, 14 Oct 2026 09:59:00 GMT" }],
  ])("ignores %s", (_, headers) => {
    expect(retryAfterMs(asking(headers), now)).toBeUndefined();
  });

  it("finds the header on an error the failure wraps", () => {
    const wrapped = new SpentError(asking({ "retry-after": "4" }), {
      inputTokens: 1,
      outputTokens: 1,
    });
    expect(retryAfterMs(wrapped, now)).toBe(4000);
  });

  it("ignores an error without response headers", () => {
    expect(retryAfterMs(serviceUnavailable(), now)).toBeUndefined();
    expect(
      retryAfterMs(Object.assign(new Error("odd"), { responseHeaders: "x" }), now),
    ).toBeUndefined();
    expect(retryAfterMs("not an error", now)).toBeUndefined();
  });

  it("reads an HTTP date against the real clock by default", () => {
    const later = new Date(Date.now() + 3_600_000).toUTCString();
    expect(retryAfterMs(asking({ "retry-after": later }))).toBe(RETRY_AFTER_CAP_MS);
  });

  it("waits what the provider asked for instead of the backoff", async () => {
    const { port, calls } = scripted([asking({ "retry-after": "2" }), serviceUnavailable()]);
    const { wait, waits } = recordingWait();
    await withRetry(port, { wait, random: () => 1, now }).complete(REQUEST);
    expect(calls()).toBe(3);
    expect(waits).toEqual([2000, BACKOFF_BASE_MS * 2]);
  });

  it("backs off as usual when the asked wait is invalid", async () => {
    const { port } = scripted([asking({ "retry-after": "soon" })]);
    const { wait, waits } = recordingWait();
    await withRetry(port, { wait, random: () => 1, now }).complete(REQUEST);
    expect(waits).toEqual([BACKOFF_BASE_MS]);
  });
});

const USAGE = (inputTokens: number, outputTokens: number): ModelUsage => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

const spentOutage = (inputTokens: number, outputTokens: number): SpentError =>
  new SpentError(serviceUnavailable(), USAGE(inputTokens, outputTokens));

describe("the tokens a failed attempt spent", () => {
  it("are found on the failure or on any error it wraps", () => {
    const failure = spentOutage(10, 2);
    expect(spentOf(failure)).toEqual(USAGE(10, 2));
    expect(spentOf(new Error("retry failed", { cause: failure }))).toEqual(USAGE(10, 2));
    expect(spentOf(serviceUnavailable())).toBeUndefined();
    expect(spentOf(undefined)).toBeUndefined();
  });

  it("keep the original failure as the cause, its message and its class", () => {
    const original = serviceUnavailable();
    const failure = new SpentError(original, USAGE(1, 1));
    expect(failure.message).toBe(original.message);
    expect(failure.cause).toBe(original);
    expect(unavailability(failure, "fallback")).toBe("unreachable");
    expect(retryable(failure)).toBe(true);
    expect(new SpentError("a bare string", USAGE(1, 1)).message).toBe("a bare string");
  });

  it("add to the reply's usage when a later attempt answers", async () => {
    const { port } = scripted([spentOutage(100, 10), spentOutage(50, 5)], {
      text: "{}",
      usage: USAGE(1000, 100),
    });
    const { wait } = recordingWait();
    const reply = await withRetry(port, { wait, random: () => 0 }).complete(REQUEST);
    expect(reply.usage).toEqual(USAGE(1150, 115));
    expect(reply.text).toBe("{}");
  });

  it("become the reply's usage when the answer reports none", async () => {
    const { port } = scripted([spentOutage(100, 10), serviceUnavailable()]);
    const { wait } = recordingWait();
    const reply = await withRetry(port, { wait, random: () => 0 }).complete(REQUEST);
    expect(reply.usage).toEqual(USAGE(100, 10));
  });

  it("travel in total on the failure that ends the attempts", async () => {
    const { port } = scripted([spentOutage(100, 10), serviceUnavailable(), spentOutage(7, 3)]);
    const { wait } = recordingWait();
    const failure = await withRetry(port, { wait, random: () => 0 })
      .complete(REQUEST)
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      );
    expect(spentOf(failure)).toEqual(USAGE(107, 13));
    expect(failure?.message).toBe(
      `${String(MODEL_ATTEMPTS)} attempts, the last: Bedrock is unable to process your request.`,
    );
    expect(unavailability(failure, "fallback")).toBe("unreachable");
  });

  it("travel in total on a refused request after failed attempts", async () => {
    const refused = forbidden();
    const { port } = scripted([spentOutage(100, 10), refused]);
    const { wait } = recordingWait();
    const failure = await withRetry(port, { wait, random: () => 0 })
      .complete(REQUEST)
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      );
    expect(spentOf(failure)).toEqual(USAGE(100, 10));
    expect(failure?.message).toBe(refused.message);
    expect(failure?.cause).toBe(refused);
    expect(unavailability(failure, "fallback")).toBe("credential-refused");
  });

  it("leave nothing to carry when no attempt spent any", async () => {
    const { port } = scripted([serviceUnavailable(), serviceUnavailable(), serviceUnavailable()]);
    const { wait } = recordingWait();
    const failure = await withRetry(port, { wait, random: () => 0 })
      .complete(REQUEST)
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      );
    expect(spentOf(failure)).toBeUndefined();
  });
});

describe("a retried request", () => {
  it("is sent again in full, its tool loop included", async () => {
    const request: ModelRequest = {
      system: "s",
      user: "u",
      tools: {
        ping: tool({
          description: "answers pong",
          inputSchema: z.object({}),
          execute: () => Promise.resolve("pong"),
        }),
      },
    };
    const { port, requests } = scripted([serviceUnavailable()]);
    const { wait } = recordingWait();
    await withRetry(port, { wait, random: () => 0 }).complete(request);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toBe(request);
    expect(requests[1]).toBe(request);
  });
});

describe("a model call that fails after a finished step", () => {
  const anthropicReply = (body: Record<string, unknown>, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const toolStep = (): Response =>
    anthropicReply({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [{ type: "tool_use", id: "call_1", name: "ping", input: {} }],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 120, output_tokens: 34 },
    });
  const overloaded = (): Response =>
    anthropicReply({ type: "error", error: { type: "api_error", message: "overloaded" } }, 503);
  const toolRequest = (): ModelRequest => ({
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
  const portAnswering = (responses: (() => Response)[]): ModelPort => {
    let call = 0;
    return createAnthropicPort({
      apiKey: "k",
      modelId: "claude-test",
      fetch: () => {
        const next = responses[call] ?? overloaded;
        call += 1;
        return Promise.resolve(next());
      },
    });
  };

  it("carries the tokens the finished steps spent, the original failure as its cause", async () => {
    const failure = await portAnswering([toolStep, overloaded])
      .complete(toolRequest())
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      );
    expect(spentOf(failure)).toMatchObject({ inputTokens: 120, outputTokens: 34 });
    expect(failure?.cause).toBeInstanceOf(APICallError);
    expect(failure?.message).toBe((failure?.cause as Error).message);
    expect(unavailability(failure, "fallback")).toBe("unreachable");
  });

  it("is the original failure when no step finished", async () => {
    const failure = await portAnswering([overloaded])
      .complete(toolRequest())
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      );
    expect(failure).toBeInstanceOf(APICallError);
    expect(spentOf(failure)).toBeUndefined();
  });
});
