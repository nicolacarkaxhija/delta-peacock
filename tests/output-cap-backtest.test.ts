import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadBacktestCases } from "../src/backtest/cases.js";
import { replayCase } from "../src/backtest/replay.js";
import { scoreRun } from "../src/backtest/score.js";
import type { ModelPort, ModelRequest } from "../src/model/port.js";
import type { ReviewReport } from "../src/review/report.js";
import { testDeps } from "./helpers/deps.js";

const BACKTEST = fileURLToPath(new URL("../bench/backtest", import.meta.url));
const CASE = "reasoning-fills-output-cap";
const DEBUG_LINE = '  console.log("panel step 3", visible.length);';
const STARVED_CAP = 4000;
const INPUT_TOKENS = 1000;

/** A model whose hidden reasoning eats a reply cap of 4000 tokens or less, leaving no text. */
function starvedModel(): { port: ModelPort; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    port: {
      complete(request) {
        requests.push(request);
        const cap = request.maxOutputTokens ?? STARVED_CAP;
        if (cap <= STARVED_CAP) {
          return Promise.resolve({
            text: "",
            finishReason: "length",
            usage: { inputTokens: INPUT_TOKENS, outputTokens: cap },
          });
        }
        const flagged = request.user.includes(`+${DEBUG_LINE}`)
          ? [
              {
                guidelineId: "no-debug-output",
                file: "src/panels/panel3.js",
                line: 5,
                quote: DEBUG_LINE,
                title: "Debug output left in",
                body: "Write this through the module logger.",
                guidelineQuote:
                  "Shipped code never calls console.log; it writes through the module logger.",
              },
            ]
          : [];
        return Promise.resolve({
          text: JSON.stringify({ findings: flagged }),
          finishReason: "stop",
          usage: { inputTokens: INPUT_TOKENS, outputTokens: 50 },
        });
      },
    },
  };
}

describe("the reasoning-fills-output-cap backtest case", () => {
  const [benchCase] = loadBacktestCases(BACKTEST, [CASE]);
  if (benchCase === undefined) throw new Error(`${CASE} is missing`);

  it("reviews every file after the doubled retry and counts every call it paid for", async () => {
    const model = starvedModel();
    const work = mkdtempSync(path.join(tmpdir(), "bt-output-cap-"));
    const run = await replayCase(testDeps(work, {}, { modelPort: model.port }), benchCase, work);
    const report = JSON.parse(run.report ?? "{}") as ReviewReport;
    expect(run.error).toBeUndefined();
    expect(report.unparsedBatches).toBeUndefined();
    expect(run.log).not.toContain("not reviewed");
    // the starved first call, then the retry at twice its cap
    const [first, second] = model.requests.map((request) => request.maxOutputTokens ?? 0);
    expect(model.requests).toHaveLength(2);
    expect(first).toBeLessThanOrEqual(STARVED_CAP);
    expect(second).toBe(2 * (first ?? 0));
    const out = (first ?? 0) + 50;
    expect(run.log).toContain(`${String(2 * INPUT_TOKENS)} tokens in, ${String(out)} out`);
    const score = scoreRun(run.findings, benchCase.expected, benchCase.noFinding);
    expect(score.wrong).toEqual([]);
    expect(score.missed).toEqual([]);
  });
});
