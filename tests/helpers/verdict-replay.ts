import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BacktestCase } from "../../src/backtest/cases.js";
import { replayCase, type Replay } from "../../src/backtest/replay.js";
import type { ModelPort, ModelReply } from "../../src/model/port.js";
import { testDeps } from "./deps.js";

const FALLBACK_LINE = '  return settings.get("retentionDays") || 30;';

type Shapes = Record<string, Record<"fallback" | "amount", Partial<ModelReply>[]>>;

/** The case's recorded review, at the given confidence when set, and its recorded verdict replies of one shape. */
export function recordedModel(
  benchCase: BacktestCase,
  shape: string,
  confidence?: number,
): ModelPort {
  const review = JSON.parse(readFileSync(path.join(benchCase.dir, "recorded.json"), "utf8")) as {
    findings: { confidence: number }[];
  };
  const text = JSON.stringify({
    findings: review.findings.map((finding) => ({
      ...finding,
      confidence: confidence ?? finding.confidence,
    })),
  });
  const shapes = JSON.parse(
    readFileSync(path.join(benchCase.dir, "recorded-verdicts.json"), "utf8"),
  ) as Shapes;
  const asked = { fallback: 0, amount: 0 };
  return {
    complete(request) {
      const usage = { inputTokens: 100, outputTokens: 10 };
      if (!request.system.includes("exclusion check")) return Promise.resolve({ text, usage });
      const line = request.user.includes(`<line>\n${FALLBACK_LINE}\n</line>`)
        ? "fallback"
        : "amount";
      const replies = shapes[shape]?.[line] ?? [];
      const reply = replies[Math.min(asked[line], replies.length - 1)] ?? {};
      asked[line] += 1;
      return Promise.resolve({ text: "", usage, ...reply });
    },
  };
}

/** One replay of the case per model the factory gives for each repeat. */
export async function replayRepeats(
  benchCase: BacktestCase,
  repeats: number,
  model: (repeat: number) => ModelPort,
): Promise<Replay[]> {
  const runs: Replay[] = [];
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const work = mkdtempSync(path.join(tmpdir(), "bt-verdict-"));
    runs.push(await replayCase(testDeps(work, {}, { modelPort: model(repeat) }), benchCase, work));
  }
  return runs;
}
