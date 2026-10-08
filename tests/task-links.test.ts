import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Finding } from "../src/domain/finding.js";
import { evaluateGate } from "../src/domain/gate.js";
import { createBitbucketPort } from "../src/scm/bitbucket.js";
import { DEFAULT_PRESENTATION, type Presentation } from "../src/scm/comment-format.js";
import type { ScmPort } from "../src/scm/port.js";
import { fingerprintEntries, lineDigest, publishReview, taskContent } from "../src/scm/publish.js";
import { startFakeBitbucket, type FakeBitbucket } from "./helpers/fake-bitbucket.js";

const finding: Finding = {
  kind: "violation",
  guidelineId: "skip-needs-ticket",
  severity: "MAJOR",
  file: "src/cart.test.ts",
  line: 12,
  title: "Failing test is skipped",
  body: "The spec skips a failing test instead of expecting it to fail.",
};

const LINE = "it.skip('totals');";

describe("task text", () => {
  const placed: Presentation = {
    ...DEFAULT_PRESENTATION,
    guidelineLink: (id) => `https://host.example/guidelines/${id}.md`,
    placeLink: () => "https://host.example/pr/1#comment-7",
  };

  it("links the guideline and the place where the host can", () => {
    expect(taskContent(finding, "abc", "12345678", placed)).toBe(
      "Major: [skip-needs-ticket](https://host.example/guidelines/skip-needs-ticket.md) in [src/cart.test.ts line 12](https://host.example/pr/1#comment-7), ref abc.12345678",
    );
  });

  it("stays plain where nothing links", () => {
    expect(taskContent(finding, "abc", "12345678")).toBe(
      "Major: skip-needs-ticket in src/cart.test.ts line 12, ref abc.12345678",
    );
  });
});

describe("bitbucket task text", () => {
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

  const publish = () =>
    publishReview(port, {
      findings: [finding],
      proposals: [],
      droppedUncited: 0,
      filtered: 0,
      gate: evaluateGate([finding], "MAJOR"),
      commitStatus: false,
      tasks: true,
      lineTextOf: () => LINE,
      dryRun: false,
    });

  it("links the task's place to the finding's comment", async () => {
    await publish();
    const comment = fake.comments.find((c) => c.inline !== undefined);
    expect(fake.tasks[0]?.content.raw).toContain(
      `in [src/cart.test.ts line 12](https://bitbucket.org/ws/repo/pull-requests/10#comment-${String(comment?.id)}), ref `,
    );
  });

  it("matches a plain task an earlier version wrote and adds no second one", async () => {
    const [entry] = fingerprintEntries([finding]);
    const ref = `${String(entry?.fingerprint)}.${lineDigest(LINE)}`;
    fake.tasks.push({
      id: 900,
      content: { raw: `High: skip-needs-ticket in src/cart.test.ts line 12, ref ${ref}` },
      state: "UNRESOLVED",
    });
    const outcome = await publish();
    expect(fake.tasks).toHaveLength(1);
    expect(outcome.tasksCreated).toBeUndefined();
  });
});
