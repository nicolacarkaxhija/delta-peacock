import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config/schema.js";
import type { Finding } from "../src/domain/finding.js";
import { evaluateGate } from "../src/domain/gate.js";
import { renderReview } from "../src/review/render.js";
import { createBitbucketPort } from "../src/scm/bitbucket.js";
import { renderSummaryBody } from "../src/scm/comment-format.js";
import type { ScmPort } from "../src/scm/port.js";
import { publishReview } from "../src/scm/publish.js";
import { startFakeBitbucket, type FakeBitbucket } from "./helpers/fake-bitbucket.js";

let fake: FakeBitbucket;
let port: ScmPort;

const FINDING: Finding = {
  kind: "violation",
  guidelineId: "values-in-settings",
  severity: "MAJOR",
  file: "src/pricing.js",
  line: 8,
  title: "Amount compared inline",
  body: "Read it from a setting.",
};

const empty = {
  proposals: [],
  droppedUncited: 0,
  filtered: 0,
  gate: evaluateGate([], "none"),
};

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

const inline = () => fake.comments.filter((comment) => comment.inline !== undefined);

function publish(findings: Finding[], held?: { findings: Finding[]; checked: number }) {
  return publishReview(port, {
    ...empty,
    findings,
    gate: evaluateGate(findings, "none"),
    ...(held !== undefined ? { held: { ...held, incomplete: false } } : {}),
    commitStatus: false,
    dryRun: false,
  });
}

describe("the exclusions.warnHeldShare setting", () => {
  it("warns from a quarter of the checked findings by default and takes a share", () => {
    expect(ConfigSchema.parse({}).exclusions.warnHeldShare).toBe(0.25);
    expect(ConfigSchema.safeParse({ exclusions: { warnHeldShare: 1.5 } }).success).toBe(false);
  });
});

describe("held findings in the log", () => {
  it("counts them and warns when the review is incomplete", () => {
    const review = {
      violations: [],
      observations: [],
      proposals: [],
      droppedUncited: 0,
      adjustedLines: 0,
      filtered: 0,
      gate: evaluateGate([], "none"),
    };
    const quiet = renderReview({ ...review, held: { count: 1, checked: 8, incomplete: false } });
    expect(quiet).toContain("1 finding(s) held: no readable exclusion verdict\n");
    expect(quiet).not.toContain("incomplete");
    expect(renderReview({ ...review, held: { count: 3, checked: 4, incomplete: true } })).toContain(
      "warning: the exclusion check gave no readable verdict for 3 of 4 checked finding(s); this review is incomplete\n",
    );
  });
});

describe("held findings in the summary", () => {
  it("names them as not posted, never reads as clean, and warns when the review is incomplete", () => {
    const scope = { changed: 1, excluded: [], outsideInclude: 0 };
    const held = { findings: [FINDING], checked: 1, incomplete: false };
    const body = renderSummaryBody({ ...empty, findings: [], scope, held });
    expect(body).not.toMatch(/^No issues/);
    expect(body).toContain("_Not posted: 1 held finding (no readable exclusion verdict)._");
    expect(body).not.toContain("incomplete");
    expect(
      renderSummaryBody({ ...empty, findings: [], scope, held: { ...held, incomplete: true } }),
    ).toContain(
      "**Warning: the exclusion check gave no readable verdict for 1 of 1 checked finding(s), held and not posted; this review is incomplete.**",
    );
  });
});

describe("a finding held on a later run", () => {
  it("keeps its earlier comment and thread as they are", async () => {
    await publish([FINDING]);
    const before = inline().map((comment) => comment.content.raw);
    expect(before).toHaveLength(1);
    const outcome = await publish([], { findings: [FINDING], checked: 1 });
    expect(inline().map((comment) => comment.content.raw)).toEqual(before);
    expect(outcome).toMatchObject({ deleted: 0, updated: 0 });
  });

  it("is retired like any finding that no longer holds when it is not held", async () => {
    await publish([FINDING]);
    await publish([]);
    expect(inline()[0]?.content.raw ?? "").toContain("Resolved in ");
  });
});
