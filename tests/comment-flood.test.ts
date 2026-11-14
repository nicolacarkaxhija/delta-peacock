import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/loader.js";
import type { Finding } from "../src/domain/finding.js";
import { evaluateGate } from "../src/domain/gate.js";
import { createBitbucketPort } from "../src/scm/bitbucket.js";
import type { ScmPort } from "../src/scm/port.js";
import { publishReview } from "../src/scm/publish.js";
import { startFakeBitbucket, type FakeBitbucket } from "./helpers/fake-bitbucket.js";
import { makeRepo } from "./helpers/git.js";

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

function findingsOf(guidelineId: string, count: number, from = 1): Finding[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "violation",
    guidelineId,
    severity: "MINOR",
    file: "tests/notes.spec.ts",
    line: from + index,
    title: `Tag the config does not declare on line ${String(from + index)}`,
    body: "Remove the tag.",
  }));
}

function publish(scm: ScmPort, findings: Finding[], foldRepeatsAbove?: number) {
  return publishReview(scm, {
    findings,
    proposals: [],
    droppedUncited: 0,
    filtered: 0,
    gate: evaluateGate(findings, "none"),
    commitStatus: true,
    dryRun: false,
    ...(foldRepeatsAbove !== undefined ? { foldRepeatsAbove } : {}),
  });
}

const inline = () => fake.comments.filter((comment) => comment.inline !== undefined);
const summary = () =>
  fake.comments.find((comment) => comment.inline === undefined)?.content.raw ?? "";

describe("a review above the fold threshold", () => {
  it("posts one comment per repeating rule naming the count, and lists the rest in the summary", async () => {
    const findings = [...findingsOf("axis-tags", 4), ...findingsOf("natural-comments", 2, 10)];
    const outcome = await publish(port, findings, 5);
    expect(inline().map((comment) => comment.inline?.to)).toEqual([1, 10]);
    expect(inline()[0]?.content.raw).toContain(
      "_This rule matches 3 more places in this pull request; the summary lists them._",
    );
    expect(inline()[1]?.content.raw).toContain("matches 1 more place in this pull request");
    expect(outcome.created).toBe(2);
    expect(summary()).toContain("on line 4");
    expect(summary()).toContain(
      "_Folded: 4 repeated findings have no comment of their own; the first of each rule does._",
    );
    expect(fake.statuses).toHaveLength(1);
  });

  it("keeps a rule that matches once as its own comment", async () => {
    const findings = [...findingsOf("axis-tags", 3), ...findingsOf("natural-comments", 1, 10)];
    await publish(port, findings, 2);
    expect(inline().map((comment) => comment.inline?.to)).toEqual([1, 10]);
    expect(inline()[1]?.content.raw).not.toContain("more place");
  });

  it("posts every finding at or below the threshold, and folds nothing without one", async () => {
    await publish(port, findingsOf("axis-tags", 3), 3);
    expect(inline()).toHaveLength(3);
    expect(summary()).not.toContain("Folded");
    await fake.close();
    fake = await startFakeBitbucket();
    fake.userEndpoint = "ok";
    port = createBitbucketPort({
      repository: "ws/repo",
      pullRequest: 10,
      token: "test-token",
      baseUrl: fake.baseUrl,
    });
    await publish(port, findingsOf("axis-tags", 3));
    expect(inline()).toHaveLength(3);
  });

  it("leaves the comment an earlier run posted for a finding it now folds", async () => {
    await publish(port, findingsOf("axis-tags", 3), 3);
    const outcome = await publish(port, findingsOf("axis-tags", 3), 2);
    expect(inline()).toHaveLength(3);
    expect(outcome).toMatchObject({ created: 0, deleted: 0, updated: 1, unchanged: 2 });
    expect(inline()[0]?.content.raw).toContain("matches 2 more places");
  });
});

describe("a host that refuses more inline comments", () => {
  function refusingAfter(posted: number, message: string): ScmPort {
    let calls = 0;
    return {
      ...port,
      createInlineComment: (comment) => {
        calls += 1;
        if (calls > posted) return Promise.reject(new Error(message));
        return port.createInlineComment(comment);
      },
    };
  }

  it("stops posting inline on a 403, posts the summary and status, and names what was left", async () => {
    const scm = refusingAfter(
      2,
      "Bitbucket denied the request (403); the token may lack permissions",
    );
    const outcome = await publish(scm, findingsOf("axis-tags", 5));
    expect(inline()).toHaveLength(2);
    expect(outcome.created).toBe(2);
    expect(outcome.notices).toEqual([
      "the host refused more inline comments (Bitbucket denied the request (403); the token may lack permissions); 3 findings are listed in the summary only",
    ]);
    expect(summary()).toContain("on line 5");
    expect(summary()).toContain(
      "_The host refused more inline comments: 3 findings appear only in this list._",
    );
    expect(fake.statuses).toHaveLength(1);
  });

  it("treats a rate or comment limit answer the same way", async () => {
    const outcome = await publish(
      refusingAfter(0, "Bitbucket rate limit exhausted; retry after the limit resets"),
      findingsOf("axis-tags", 1),
    );
    expect(inline()).toHaveLength(0);
    expect(outcome.notices[0]).toContain("1 finding is listed in the summary only");
    expect(summary()).toContain("1 finding appears only in this list");
  });

  it("still fails the step on any other error", async () => {
    await expect(
      publish(
        refusingAfter(0, "Bitbucket responded 500 to POST comments"),
        findingsOf("axis-tags", 1),
      ),
    ).rejects.toThrow("500");
  });
});

describe("the fold threshold setting", () => {
  it("defaults to 25 findings", () => {
    expect(Reflect.get(loadConfig({ root: makeRepo() }).scm, "foldRepeatsAbove")).toBe(25);
  });
});
