import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import type { ModelPort, ModelReply } from "../src/model/port.js";
import {
  BACKOFF_BASE_MS,
  MODEL_ATTEMPTS,
  backoffMs,
  retryable,
  withRetry,
} from "../src/model/retry.js";
import { ModelUnavailableError, unavailability } from "../src/model/unavailable.js";

const apiError = (statusCode: number | undefined, message: string, cause?: unknown): APICallError =>
  new APICallError({
    message,
    url: "https://bedrock-runtime.example.com/model/m/converse",
    requestBodyValues: {},
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(cause !== undefined ? { cause } : {}),
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
function scripted(errors: readonly Error[]): { port: ModelPort; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    port: {
      complete: () => {
        const error = errors[calls];
        calls += 1;
        return error === undefined ? Promise.resolve(ANSWER) : Promise.reject(error);
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
