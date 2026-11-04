import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadBacktestCases, type BacktestCase } from "../src/backtest/cases.js";
import { replayCase } from "../src/backtest/replay.js";
import { scoreRun } from "../src/backtest/score.js";
import { loadConfig } from "../src/config/loader.js";
import { approximateTokens } from "../src/context/port.js";
import { DEFAULT_MAX_OUTPUT_TOKENS, type ModelPort, type ModelRequest } from "../src/model/port.js";
import { promptBudget } from "../src/review/budget.js";
import type { ReviewReport } from "../src/review/report.js";
import { testDeps } from "./helpers/deps.js";

const BACKTEST = fileURLToPath(new URL("../bench/backtest", import.meta.url));
const CASE = "near-limit-diff-unparseable-reply";
const DEBUG_LINE = '  console.log("gallery step 3", visible.length);';

const promptTokens = (request: ModelRequest): number =>
  approximateTokens(request.system) + approximateTokens(request.user);

/**
 * A model that answers in prose once the prompt leaves it less room than its
 * reply cap, the way a reply cut off near the window reads; with room it
 * flags the debug line wherever the batch holds it.
 */
function nearLimitModel(windowTokens: number): { port: ModelPort; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    port: {
      complete(request) {
        requests.push(request);
        if (promptTokens(request) + DEFAULT_MAX_OUTPUT_TOKENS > windowTokens) {
          return Promise.resolve({
            text: "The change is large; I will go through it file by file",
          });
        }
        const flagged = request.user.includes(`+${DEBUG_LINE}`)
          ? [
              {
                guidelineId: "no-debug-output",
                file: "src/widgets/gallery.js",
                line: 31,
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
          usage: { inputTokens: promptTokens(request), outputTokens: 50 },
        });
      },
    },
  };
}

async function replay(benchCase: BacktestCase, port: ModelPort) {
  const work = mkdtempSync(path.join(tmpdir(), "bt-near-limit-"));
  const run = await replayCase(testDeps(work, {}, { modelPort: port }), benchCase, work);
  const report = JSON.parse(run.report ?? "{}") as ReviewReport;
  return { run, report };
}

describe("the near-limit backtest case", () => {
  const [nearLimit] = loadBacktestCases(BACKTEST, [CASE]);
  if (nearLimit === undefined) throw new Error(`${CASE} is missing`);
  const windowTokens = loadConfig({ root: nearLimit.baseDir }).review.windowTokens;

  it("keeps every prompt under the budget with room for the reply, so the finding stands", async () => {
    const model = nearLimitModel(windowTokens);
    const { run, report } = await replay(nearLimit, model.port);
    expect(run.error).toBeUndefined();
    expect(run.log).toMatch(/^full_files context: 18 changed file\(s\)/m);
    expect(run.log).toContain("exceeds the prompt budget");
    for (const request of model.requests) {
      expect(promptTokens(request)).toBeLessThanOrEqual(
        promptBudget(windowTokens, DEFAULT_MAX_OUTPUT_TOKENS),
      );
    }
    expect(report.unparsedBatches).toBeUndefined();
    const score = scoreRun(run.findings, nearLimit.expected, nearLimit.noFinding);
    expect(score.wrong).toEqual([]);
    expect(score.missed).toEqual([]);
  });

  it("finishes and names every file when no reply can be read", async () => {
    const prose: ModelPort = {
      complete: () => Promise.resolve({ text: "I need to look at more files first." }),
    };
    const { run, report } = await replay(nearLimit, prose);
    expect(run.error).toBeUndefined();
    expect(run.log).toContain("reviewed 0 of 18 files; not reviewed: reply unparseable: ");
    expect(new Set(report.unparsedBatches?.flatMap((entry) => entry.files)).size).toBe(18);
  });
});
