import { describe, expect, it } from "vitest";
import { approximateTokens } from "../src/context/port.js";
import { runCli } from "../src/index.js";
import type { ModelPort, ModelRequest } from "../src/model/port.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const RULES = Array.from(
  { length: 12 },
  (_, index) =>
    `Rule ${String(index + 1)}: every exported value carries a name that says what it measures, and a comment when the amount is not obvious from the name alone.`,
).join("\n\n");
const GUIDELINE = `---\nid: named-values\nseverity: MINOR\n---\n# Named values\n\n${RULES}\n`;

const FILES = Array.from({ length: 12 }, (_, index) => `src/part${String(index + 1)}.ts`);

function moduleText(file: string): string {
  return Array.from(
    { length: 40 },
    (_, line) => `export const ${file.replace(/\W/g, "_")}_value${String(line)} = ${String(line)};`,
  ).join("\n");
}

function repoWith(files: readonly string[]): string {
  const cwd = makeRepo();
  write(cwd, "guidelines/named-values.md", GUIDELINE);
  commitAll(cwd, "rules");
  git(cwd, "checkout", "-q", "-b", "feature");
  for (const file of files) write(cwd, file, `${moduleText(file)}\n`);
  commitAll(cwd, "change");
  return cwd;
}

/** What one review sends: every request, its tokens, and the cacheable prefix of each. */
async function measure(files: readonly string[]): Promise<{
  requests: ModelRequest[];
  sent: number;
  fresh: number;
}> {
  const requests: ModelRequest[] = [];
  const port: ModelPort = {
    complete(request) {
      requests.push(request);
      return Promise.resolve({ text: '{"findings": []}' });
    },
  };
  await runCli(["review"], {
    cwd: repoWith(files),
    env: {
      DELTA_PEACOCK_CONTEXT_PROVIDER: "full_files",
      DELTA_PEACOCK_CONTEXT_MAX_TOKENS: "20000",
      DELTA_PEACOCK_REVIEW_MAX_FILES_PER_BATCH: "4",
    },
    out: () => undefined,
    err: () => undefined,
    modelPort: port,
  });
  const tokens = (request: ModelRequest): number =>
    approximateTokens(request.system) + approximateTokens(request.user);
  const prefix = (request: ModelRequest): number =>
    approximateTokens(request.system.slice(0, request.stablePrefix ?? 0));
  const sent = requests.reduce((sum, request) => sum + tokens(request), 0);
  // a provider that caches reads the shared prefix fresh once per review
  const cached = requests.slice(1).reduce((sum, request) => sum + prefix(request), 0);
  return { requests, sent, fresh: sent - cached };
}

describe("the cost of a change reviewed in batches", () => {
  it("gives each batch the context of its own files only", async () => {
    const { requests } = await measure(FILES);
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      const fenced = FILES.filter((file) => request.system.includes(`=== ${file} ===`));
      const reviewed = FILES.filter((file) => request.user.includes(`b/${file}`));
      expect(fenced).toEqual(reviewed);
    }
  });

  it("costs no more than the same files reviewed as separate small changes", async () => {
    const whole = await measure(FILES);
    const parts = await Promise.all(
      [FILES.slice(0, 4), FILES.slice(4, 8), FILES.slice(8)].map((files) => measure(files)),
    );
    const separate = parts.reduce((sum, part) => sum + part.sent, 0);
    expect(whole.sent).toBeLessThanOrEqual(separate);
    // with the guidelines cached, the batches pay for the shared prefix once
    expect(whole.fresh).toBeLessThan(whole.sent);
  });
});
