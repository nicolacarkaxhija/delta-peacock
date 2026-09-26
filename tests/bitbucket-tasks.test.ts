import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/loader.js";
import type { Finding } from "../src/domain/finding.js";
import { evaluateGate } from "../src/domain/gate.js";
import { createBitbucketPort } from "../src/scm/bitbucket.js";
import type { ScmPort } from "../src/scm/port.js";
import { lineDigest, publishReview, taskContent } from "../src/scm/publish.js";
import { runCli } from "../src/index.js";
import type { ModelPort } from "../src/model/port.js";
import { startFakeBitbucket, type FakeBitbucket } from "./helpers/fake-bitbucket.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const finding: Finding = {
  kind: "violation",
  guidelineId: "prefer-test-ids",
  severity: "MAJOR",
  file: "pages/pdp.ts",
  line: 29,
  title: "Raw CSS selector",
  body: "Use the test id the element already has.",
};

let fake: FakeBitbucket;
let port: ScmPort;

beforeEach(async () => {
  fake = await startFakeBitbucket();
  fake.userEndpoint = "ok";
  port = createBitbucketPort({
    repository: "ws/repo",
    pullRequest: 10,
    token: "test-token",
    baseUrl: fake.baseUrl,
  });
});

afterEach(async () => {
  await fake.close();
});

function publish(findings: Finding[], lineText: string, tasks = true) {
  return publishReview(port, {
    findings,
    proposals: [],
    droppedUncited: 0,
    filtered: 0,
    gate: evaluateGate(findings, "MAJOR"),
    commitStatus: false,
    tasks,
    lineTextOf: () => lineText,
    dryRun: false,
  });
}

describe("bitbucket pull request tasks", () => {
  it("creates one task per posted finding, attached to its comment", async () => {
    const outcome = await publish([finding], "const panel = '.size-guide';");
    expect(fake.tasks).toHaveLength(1);
    const [task] = fake.tasks;
    expect(task?.comment?.id).toBe(fake.comments.find((c) => c.inline !== undefined)?.id);
    expect(task?.content.raw).toMatch(
      /^High: prefer-test-ids in pages\/pdp\.ts line 29, ref [0-9a-f]+\.[0-9a-f]{8}$/,
    );
    expect(outcome.tasksCreated).toBe(1);
  });

  it("never creates a second task for a finding that already has one", async () => {
    await publish([finding], "const panel = '.size-guide';");
    const again = await publish([finding], "const panel = '.size-guide';");
    expect(fake.tasks).toHaveLength(1);
    expect(again.tasksCreated).toBeUndefined();
  });

  it("resolves its own task once the anchored line changed", async () => {
    await publish([finding], "const panel = '.size-guide';");
    const outcome = await publish([], "const panel = page.getByTestId('size-guide');");
    expect(fake.tasks[0]?.state).toBe("RESOLVED");
    expect(outcome.tasksResolved).toBe(1);
  });

  it("leaves the task open while the finding stands on an unchanged line", async () => {
    await publish([finding], "const panel = '.size-guide';");
    await publish([finding], "const panel = '.size-guide';");
    expect(fake.tasks[0]?.state).toBe("UNRESOLVED");
  });

  it("resolves the task before its comment becomes the trace of the fix", async () => {
    await publish([finding], "const panel = '.size-guide';");
    const outcome = await publishReview(port, {
      findings: [],
      proposals: [],
      droppedUncited: 0,
      filtered: 0,
      gate: evaluateGate([], "MAJOR"),
      commitStatus: true,
      tasks: true,
      lineTextOf: () => "const panel = page.getByTestId('size-guide');",
      resolvedIn: "0123456789abcdef",
      dryRun: false,
    });
    expect(fake.tasks[0]?.state).toBe("RESOLVED");
    const comment = fake.comments.find((entry) => entry.inline !== undefined);
    expect(comment?.content.raw).toContain("Resolved in `0123456789ab`");
    const taskWrite = fake.writes.findIndex((write) => /\/tasks\/\d+$/.test(write.url));
    const commentWrite = fake.writes.findIndex(
      (write, index) => index > 0 && write.method === "PUT" && /\/comments\/\d+$/.test(write.url),
    );
    expect(taskWrite).toBeGreaterThan(-1);
    expect(taskWrite).toBeLessThan(commentWrite);
    expect(fake.writes.some((write) => write.method === "DELETE")).toBe(false);
    expect(outcome).toMatchObject({ deleted: 1, tasksResolved: 1 });
    expect(fake.statuses.at(-1)?.state).toBe("SUCCESSFUL");
  });

  it("counts a comment already gone as done and notes a thread it could not resolve", async () => {
    await publish([finding], "const panel = '.size-guide';");
    const gone: ScmPort = {
      ...port,
      updateComment: () => Promise.reject(new Error("Bitbucket responded 404 to PUT comments/1")),
    };
    const quiet = await publishReview(gone, {
      findings: [],
      proposals: [],
      droppedUncited: 0,
      filtered: 0,
      gate: evaluateGate([], "MAJOR"),
      commitStatus: false,
      dryRun: false,
    });
    expect(quiet).toMatchObject({ deleted: 0, notices: [] });
    const stuck: ScmPort = {
      ...port,
      resolveComment: () => Promise.reject(new Error("Bitbucket responded 409 to POST resolve")),
    };
    const noted = await publishReview(stuck, {
      findings: [],
      proposals: [],
      droppedUncited: 0,
      filtered: 0,
      gate: evaluateGate([], "MAJOR"),
      commitStatus: false,
      dryRun: false,
    });
    expect(noted.deleted).toBe(1);
    expect(noted.notices).toEqual([
      expect.stringMatching(
        /^could not resolve the thread of comment \d+ \(.*409.*\); continuing$/,
      ),
    ]);
  });

  it("finishes a passed review when cleanup fails, and treats a gone task as done", async () => {
    await publish([finding], "const panel = '.size-guide';");
    const [task] = fake.tasks;
    const flaky: ScmPort = {
      ...port,
      // the task vanished with its comment on Bitbucket's side: 404
      resolveTask: () =>
        Promise.reject(new Error(`Bitbucket responded 404 to PUT tasks/${String(task?.id)}`)),
      // the comment edit hits a server error
      updateComment: () => Promise.reject(new Error("Bitbucket responded 500 to PUT comments/1")),
    };
    const outcome = await publishReview(flaky, {
      findings: [],
      proposals: [],
      droppedUncited: 0,
      filtered: 0,
      gate: evaluateGate([], "MAJOR"),
      commitStatus: true,
      tasks: true,
      lineTextOf: () => "changed",
      dryRun: false,
    });
    expect(outcome.tasksResolved).toBeUndefined();
    expect(outcome.deleted).toBe(0);
    expect(outcome.notices).toEqual([
      expect.stringMatching(/could not mark comment \d+ resolved .*500.*continuing/),
    ]);
    expect(fake.statuses.at(-1)?.state).toBe("SUCCESSFUL");
    expect(fake.comments.some((entry) => entry.inline === undefined)).toBe(true);
  });

  it("does not repost a finding whose task a person resolved", async () => {
    await publish([finding], "const panel = '.size-guide';");
    const [task] = fake.tasks;
    if (task) {
      task.state = "RESOLVED";
      task.resolved_by = { uuid: "{person-1}" };
    }
    const commentsBefore = fake.comments.length;
    const outcome = await publish([finding], "const panel = '.size-guide';");
    expect(fake.comments).toHaveLength(commentsBefore);
    expect(fake.tasks).toHaveLength(1);
    expect(outcome.created).toBe(0);
    expect(outcome.deleted).toBe(0);
  });

  it("ignores tasks it did not write and creates none when switched off", async () => {
    fake.tasks.push({ id: 900, content: { raw: "check the copy" }, state: "UNRESOLVED" });
    await publish([finding], "x", false);
    expect(fake.tasks).toHaveLength(1);
    await publish([finding], "x");
    expect(fake.tasks.find((task) => task.id === 900)?.state).toBe("UNRESOLVED");
    expect(fake.tasks).toHaveLength(2);
  });

  it("notes a host without tasks instead of failing", async () => {
    const plain: ScmPort = {
      listInlineComments: () => Promise.resolve([]),
      createInlineComment: () => Promise.resolve(),
      updateComment: () => Promise.resolve(),
      deleteComment: () => Promise.resolve(),
      listSummaryComments: () => Promise.resolve([]),
      createSummaryComment: () => Promise.resolve(),
      updateSummaryComment: () => Promise.resolve(),
      postStatus: () => Promise.resolve(),
    };
    const outcome = await publishReview(plain, {
      findings: [finding],
      proposals: [],
      droppedUncited: 0,
      filtered: 0,
      gate: evaluateGate([finding], "MAJOR"),
      commitStatus: false,
      tasks: true,
      dryRun: false,
    });
    expect(outcome.notices).toContain("this provider has no pull request tasks; skipping them");
  });

  it("creates tasks from a review run and resolves them after the line changes", async () => {
    const repo = makeRepo();
    write(
      repo,
      "guidelines/no-console.md",
      "---\nid: no-console\nseverity: MAJOR\n---\n# No console\n\nUse the logger, never console output.\n",
    );
    commitAll(repo, "rules");
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "src/app.js", "console.log('x');\n");
    commitAll(repo, "change");
    const reply = JSON.stringify({
      findings: [
        {
          guidelineId: "no-console",
          file: "src/app.js",
          line: 1,
          quote: "console.log('x');",
          guidelineQuote: "Use the logger, never console output.",
          title: "Console",
          body: "Use the logger.",
        },
      ],
    });
    const run = async (text: string): Promise<string> => {
      let stderr = "";
      const model: ModelPort = { complete: () => Promise.resolve({ text }) };
      await runCli(["review"], {
        cwd: repo,
        env: {
          DELTA_PEACOCK_SCM_PROVIDER: "bitbucket",
          DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
          DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
          DELTA_PEACOCK_SCM_BASE_URL: fake.baseUrl,
          DELTA_PEACOCK_SCM_TASKS: "true",
          BITBUCKET_TOKEN: "test-token",
        },
        out: () => undefined,
        err: (chunk) => {
          stderr += chunk;
        },
        modelPort: model,
      });
      return stderr;
    };
    expect(await run(reply)).toContain("tasks: 1 created, 0 resolved");
    expect(fake.tasks[0]?.content.raw).toMatch(/^High: no-console in src\/app\.js line 1, ref /);
    write(repo, "src/app.js", "logger.info('x');\n");
    commitAll(repo, "fix");
    expect(await run('{"findings": []}')).toContain("tasks: 0 created, 1 resolved");
    expect(fake.tasks[0]?.state).toBe("RESOLVED");
  });

  it("reads scm.tasks from the environment, off by default", () => {
    expect(loadConfig({ root: process.cwd(), env: {} }).scm.tasks).toBe(false);
    expect(
      loadConfig({ root: process.cwd(), env: { DELTA_PEACOCK_SCM_TASKS: "true" } }).scm.tasks,
    ).toBe(true);
  });

  it("digests a line by its trimmed text and names the observation lane", () => {
    expect(lineDigest("  a  ")).toBe(lineDigest("a"));
    expect(lineDigest(undefined)).toBe(lineDigest(""));
    const observation: Finding = {
      kind: "observation",
      severity: "MINOR",
      file: "pages/pdp.ts",
      line: 29,
      title: "t",
      body: "b",
    };
    expect(taskContent(observation, "abc", "12345678")).toContain("observation in pages/pdp.ts");
  });
});
