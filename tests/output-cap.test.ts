import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config/loader.js";
import { createBedrockPort } from "../src/model/bedrock.js";
import { buildModelPort } from "../src/model/build.js";
import { withResponseCache } from "../src/model/cache.js";
import { DEFAULT_MAX_OUTPUT_TOKENS, type ModelPort, type ModelReply } from "../src/model/port.js";
import {
  OUTPUT_CAP_HIT,
  OUTPUT_CAP_RETRY_FACTOR,
  REASONING_HEADROOM_TOKENS,
  REPLY_TOKENS_PER_FILE,
  hitOutputCap,
  outputCapFor,
} from "../src/review/output-cap.js";
import {
  planPasses,
  retryRequest,
  runPasses,
  type PlannedPass,
  type PromptOf,
} from "../src/review/run-review.js";
import { makeRepo } from "./helpers/git.js";

const fileDiff = (name: string): string =>
  `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -0,0 +1 @@\n+${name}\n`;

const promptOf: PromptOf = (diffText) => ({ system: "rules", user: diffText });

const parseOptions = {
  guidelinesById: new Map(),
  generalPass: false,
  observationSeverityCap: "MINOR" as const,
};

const CAPPED: ModelReply = {
  text: "",
  finishReason: "length",
  usage: { inputTokens: 100, outputTokens: 50 },
};
const ANSWER: ModelReply = {
  text: '{"findings": []}',
  finishReason: "stop",
  usage: { inputTokens: 100, outputTokens: 20 },
};

/** A model that runs out of output unless the cap exceeds the threshold. */
function capLimitedModel(threshold: number): { port: ModelPort; caps: (number | undefined)[] } {
  const caps: (number | undefined)[] = [];
  return {
    caps,
    port: {
      complete(request) {
        caps.push(request.maxOutputTokens);
        return Promise.resolve((request.maxOutputTokens ?? 0) > threshold ? ANSWER : CAPPED);
      },
    },
  };
}

const passOf = (
  files: string[],
  maxOutputTokens: number,
  slices?: PlannedPass[],
  outputCeiling = 1_000_000,
): PlannedPass => ({
  label: "batch 1/1",
  request: { system: "rules", user: files.join(","), maxOutputTokens },
  files,
  outputCeiling,
  ...(slices !== undefined ? { slices: () => Promise.resolve(slices) } : {}),
});

describe("outputCapFor", () => {
  it("grows from the reasoning headroom by an allowance per file", () => {
    expect(outputCapFor(1, 1_000_000)).toBe(REASONING_HEADROOM_TOKENS + REPLY_TOKENS_PER_FILE);
    expect(outputCapFor(3, 1_000_000)).toBe(REASONING_HEADROOM_TOKENS + 3 * REPLY_TOKENS_PER_FILE);
  });

  it("never exceeds the configured ceiling", () => {
    expect(outputCapFor(50, 9000)).toBe(9000);
  });

  it("budgets at least one file", () => {
    expect(outputCapFor(0, 1_000_000)).toBe(outputCapFor(1, 1_000_000));
  });
});

describe("hitOutputCap", () => {
  it("is true for a length stop with no text", () => {
    expect(hitOutputCap(CAPPED)).toBe(true);
    expect(hitOutputCap({ text: "  \n", finishReason: "length" })).toBe(true);
  });

  it("is false when the reply has text or stopped on its own", () => {
    expect(hitOutputCap({ text: "{", finishReason: "length" })).toBe(false);
    expect(hitOutputCap({ text: "", finishReason: "stop" })).toBe(false);
    expect(hitOutputCap({ text: "" })).toBe(false);
  });
});

describe("the output cap of a planned pass", () => {
  it("scales with the files of the pass under review.maxOutputTokens", () => {
    const config = loadConfig({ root: makeRepo(), flags: { "review.maxOutputTokens": "7000" } });
    const passes = planPasses(
      config,
      [fileDiff("a.js"), fileDiff("b.js") + fileDiff("c.js") + fileDiff("d.js")],
      [],
      undefined,
      promptOf,
    );
    expect(passes.map((pass) => pass.request.maxOutputTokens)).toEqual([
      REASONING_HEADROOM_TOKENS + REPLY_TOKENS_PER_FILE,
      7000,
    ]);
    expect(passes.map((pass) => pass.outputCeiling)).toEqual([7000, 7000]);
  });

  it("defaults to a ceiling above what reasoning alone consumed", () => {
    const config = loadConfig({ root: makeRepo() });
    expect(config.review.maxOutputTokens).toBeGreaterThan(4000);
  });
});

describe("retryRequest", () => {
  it("doubles the cap after a reply that ran out of output and does not replay an empty reply", () => {
    const retry = retryRequest({ system: "s", user: "u", maxOutputTokens: 5000 }, CAPPED, 16_000);
    expect(retry.maxOutputTokens).toBe(10_000);
    expect(retry.user).not.toContain("<reply>");
  });

  it("never raises the cap of a retry above the ceiling", () => {
    const retry = retryRequest({ system: "s", user: "u", maxOutputTokens: 12_000 }, CAPPED, 16_000);
    expect(retry.maxOutputTokens).toBe(16_000);
  });

  it("doubles the plain reply cap when the request named none, under the ceiling", () => {
    expect(retryRequest({ system: "s", user: "u" }, CAPPED, 16_000).maxOutputTokens).toBe(
      DEFAULT_MAX_OUTPUT_TOKENS * OUTPUT_CAP_RETRY_FACTOR,
    );
    expect(retryRequest({ system: "s", user: "u" }, CAPPED, 5000).maxOutputTokens).toBe(5000);
  });

  it("keeps the cap after a reply that held prose", () => {
    const retry = retryRequest(
      { system: "s", user: "u", maxOutputTokens: 5000 },
      { text: "thinking aloud", finishReason: "stop" },
      16_000,
    );
    expect(retry.maxOutputTokens).toBe(5000);
    expect(retry.user).toContain("thinking aloud");
  });
});

describe("a pass whose reply hit the output cap", () => {
  it("is asked once more with a doubled cap and then reads", async () => {
    const model = capLimitedModel(150);
    const err: string[] = [];
    const executed = await runPasses(
      { err: (text) => err.push(text) },
      model.port,
      [passOf(["a.js"], 100)],
      parseOptions,
    );
    expect(model.caps).toEqual([100, 200]);
    expect(executed.unparsedBatches).toEqual([]);
    expect(executed.usage).toMatchObject({ inputTokens: 200, outputTokens: 70 });
    expect(err.join("")).toContain(OUTPUT_CAP_HIT);
  });

  it("is asked once more at the ceiling when twice the cap would pass it", async () => {
    const model = capLimitedModel(Number.POSITIVE_INFINITY);
    await runPasses(
      { err: () => undefined },
      model.port,
      [passOf(["a.js"], 100, undefined, 150)],
      parseOptions,
    );
    expect(model.caps).toEqual([100, 150]);
  });

  it("names the files as output cap hit, not unparseable, once the slices fail too", async () => {
    const model = capLimitedModel(Number.POSITIVE_INFINITY);
    const slices = [passOf(["a.js"], 100), passOf(["b.js"], 100)];
    const executed = await runPasses(
      { err: () => undefined },
      model.port,
      [passOf(["a.js", "b.js"], 100, slices)],
      parseOptions,
    );
    expect(executed.unparsedBatches.map((entry) => [entry.reason, entry.files])).toEqual([
      [OUTPUT_CAP_HIT, ["a.js"]],
      [OUTPUT_CAP_HIT, ["b.js"]],
    ]);
    // the first call, its retry and one call per slice, every one paid for
    expect(model.caps).toEqual([100, 200, 100, 100]);
    expect(executed.usage).toMatchObject({ inputTokens: 400, outputTokens: 200 });
  });

  it("still names a prose reply unparseable", async () => {
    const port: ModelPort = {
      complete: () =>
        Promise.resolve({ text: "no json here", usage: { inputTokens: 5, outputTokens: 1 } }),
    };
    const executed = await runPasses(
      { err: () => undefined },
      port,
      [passOf(["a.js"], 100)],
      parseOptions,
    );
    expect(executed.unparsedBatches[0]?.reason).not.toBe(OUTPUT_CAP_HIT);
    expect(executed.usage).toMatchObject({ inputTokens: 10, outputTokens: 2 });
  });
});

describe("the response cache", () => {
  it("does not keep a reply that ran out of output", async () => {
    const dir = makeRepo();
    const config = loadConfig({ root: dir, flags: { "cache.enabled": "true" } });
    let calls = 0;
    const port: ModelPort = {
      complete() {
        calls += 1;
        return Promise.resolve(calls === 1 ? CAPPED : ANSWER);
      },
    };
    const cached = withResponseCache(
      port,
      config,
      dir,
      () => new Date(0),
      () => undefined,
    );
    const request = { system: "s", user: "u" };
    expect((await cached.complete(request)).text).toBe("");
    expect((await cached.complete(request)).text).toBe(ANSWER.text);
  });
});

describe("reasoning effort on Bedrock", () => {
  async function sentBody(reasoningEffort?: "low" | "high"): Promise<Record<string, unknown>> {
    const bodies: Record<string, unknown>[] = [];
    const port = createBedrockPort({
      region: "eu-central-1",
      accessKeyId: "AKIA_TEST",
      secretAccessKey: "secret",
      modelId: "eu.anthropic.claude-test",
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      fetch: (_input, init) => {
        bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              output: { message: { role: "assistant", content: [{ text: "{}" }] } },
              stopReason: "max_tokens",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      },
    });
    const reply = await port.complete({ system: "s", user: "u" });
    expect(reply.finishReason).toBe("length");
    return bodies[0] ?? {};
  }

  it("sends the effort the config names", async () => {
    const body = await sentBody("low");
    expect(body["additionalModelRequestFields"]).toMatchObject({
      output_config: { effort: "low" },
    });
  });

  it("sends nothing when no effort is named", async () => {
    expect((await sentBody())["additionalModelRequestFields"]).toBeUndefined();
  });

  it("sends the effort model.reasoningEffort names through the port builder", async () => {
    const bodies: Record<string, unknown>[] = [];
    const credentials = {
      AWS_REGION: "eu-central-1",
      AWS_ACCESS_KEY_ID: "AKIA_TEST",
      AWS_SECRET_ACCESS_KEY: "secret",
    };
    const config = loadConfig({
      root: makeRepo(),
      env: {
        DELTA_PEACOCK_MODEL_PROVIDER: "bedrock",
        DELTA_PEACOCK_MODEL_ID: "eu.anthropic.claude-test",
        DELTA_PEACOCK_MODEL_REASONING_EFFORT: "medium",
      },
    });
    vi.stubGlobal("fetch", (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            output: { message: { role: "assistant", content: [{ text: "{}" }] } },
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    try {
      await buildModelPort(config, credentials).complete({ system: "s", user: "u" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(bodies[0]?.["additionalModelRequestFields"]).toMatchObject({
      output_config: { effort: "medium" },
    });
  });
});

describe("the config keys", () => {
  it("reads review.maxOutputTokens from the environment", () => {
    const config = loadConfig({
      root: makeRepo(),
      env: { DELTA_PEACOCK_REVIEW_MAX_OUTPUT_TOKENS: "9000" },
    });
    expect(config.review.maxOutputTokens).toBe(9000);
  });

  it("rejects a ceiling that is not a positive whole number", () => {
    expect(() =>
      loadConfig({ root: makeRepo(), flags: { "review.maxOutputTokens": "0" } }),
    ).toThrow();
  });

  it("leaves reasoning effort unset by default and reads it from the environment", () => {
    expect(loadConfig({ root: makeRepo() }).model.reasoningEffort).toBeUndefined();
    const config = loadConfig({
      root: makeRepo(),
      env: { DELTA_PEACOCK_MODEL_REASONING_EFFORT: "low" },
    });
    expect(config.model.reasoningEffort).toBe("low");
  });
});
