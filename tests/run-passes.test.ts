import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/loader.js";
import type { ModelPort, ModelReply, ModelRequest } from "../src/model/port.js";
import { planPasses, runPasses, type PromptOf } from "../src/review/run-review.js";
import { makeRepo } from "./helpers/git.js";

const fileDiff = (name: string): string =>
  `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -0,0 +1 @@\n+${name}\n`;

const promptOf: PromptOf = (diffText, context) => ({
  system: "rules",
  user: `${context}|${diffText}`,
});

const parseOptions = {
  guidelinesById: new Map(),
  generalPass: false,
  observationSeverityCap: "MINOR" as const,
};

describe("planPasses", () => {
  it("sends a batch with no context entry without context", () => {
    const passes = planPasses(
      loadConfig({ root: makeRepo() }),
      [fileDiff("a.js")],
      [],
      undefined,
      promptOf,
    );
    expect(passes.map((pass) => pass.request.user)).toEqual([`|${fileDiff("a.js")}`]);
    expect(passes[0]?.slices).toBeUndefined();
  });

  it("cuts a batch into slices that carry their own context, and keeps a batch without context bare", async () => {
    const asked: string[] = [];
    const contextOf = (diffText: string): Promise<string> => {
      asked.push(diffText);
      return Promise.resolve("sliced");
    };
    const both = fileDiff("a.js") + fileDiff("b.js");
    const [withContext, bare] = planPasses(
      loadConfig({ root: makeRepo() }),
      [both, both],
      ["whole", ""],
      undefined,
      promptOf,
      contextOf,
    );
    const sliced = (await withContext?.slices?.()) ?? [];
    expect(sliced.map((pass) => [pass.label, pass.request.user, pass.files])).toEqual([
      ["batch 1/2, slice 1/2", `sliced|${fileDiff("a.js")}`, ["a.js"]],
      ["batch 1/2, slice 2/2", `sliced|${fileDiff("b.js")}`, ["b.js"]],
    ]);
    const bareSlices = (await bare?.slices?.()) ?? [];
    expect(bareSlices.map((pass) => pass.request.user)).toEqual([
      `|${fileDiff("a.js")}`,
      `|${fileDiff("b.js")}`,
    ]);
    expect(asked).toEqual([fileDiff("a.js"), fileDiff("b.js")]);
  });
});

describe("runPasses", () => {
  it("keeps the first reply's usage when the request for the JSON answer reports none", async () => {
    const replies: ModelReply[] = [
      { text: "Let me think.", usage: { inputTokens: 10, outputTokens: 2 } },
      { text: '{"findings": []}' },
    ];
    const requests: ModelRequest[] = [];
    const port: ModelPort = {
      complete(request) {
        requests.push(request);
        return Promise.resolve(replies[requests.length - 1] ?? { text: "" });
      },
    };
    const passes = planPasses(
      loadConfig({ root: makeRepo() }),
      [fileDiff("a.js")],
      [""],
      undefined,
      promptOf,
    );
    const executed = await runPasses({ err: () => undefined }, port, passes, parseOptions);
    expect(requests).toHaveLength(2);
    expect(executed.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(executed.unparsedBatches).toEqual([]);
  });
});
