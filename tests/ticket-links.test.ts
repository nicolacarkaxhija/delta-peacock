import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { renderConfigYaml, DEFAULT_ANSWERS } from "../src/commands/init.js";
import { loadConfig } from "../src/config/loader.js";
import { ConfigSchema } from "../src/config/schema.js";
import type { Finding } from "../src/domain/finding.js";
import { evaluateGate } from "../src/domain/gate.js";
import { createBitbucketPort } from "../src/scm/bitbucket.js";
import {
  DEFAULT_PRESENTATION,
  linkTickets,
  renderCommentBody,
  renderSummaryBody,
  type Presentation,
} from "../src/scm/comment-format.js";
import type { ScmPort } from "../src/scm/port.js";
import { presentationFor, publishReview } from "../src/scm/publish.js";
import { startFakeBitbucket, type FakeBitbucket } from "./helpers/fake-bitbucket.js";

const TRACKER = "https://tracker.example.com/browse/{key}";
const PATTERN = "[A-Z][A-Z0-9]+-\\d+";

const linked: Presentation = {
  ...DEFAULT_PRESENTATION,
  tickets: { pattern: PATTERN, link: (key) => `https://tracker.example.com/browse/${key}` },
};

const finding: Finding = {
  kind: "violation",
  guidelineId: "skip-needs-ticket",
  severity: "MAJOR",
  file: "src/cart.test.ts",
  line: 12,
  title: "Failing test ABC-123 is skipped",
  body: "The spec skips ABC-123 instead of expecting it to fail. Use `expectFailure(ABC-123)`.",
  suggestion: "expectFailure('ABC-123', 'team');",
};

describe("ticket links", () => {
  it("links a key in prose to its ticket", () => {
    expect(linkTickets("Fails since ABC-123 landed.", linked)).toBe(
      "Fails since [ABC-123](https://tracker.example.com/browse/ABC-123) landed.",
    );
  });

  it("leaves a key in a code span as code", () => {
    expect(linkTickets("Call `skip(ABC-123)` here.", linked)).toBe("Call `skip(ABC-123)` here.");
  });

  it("leaves a key inside an existing link or address alone", () => {
    const text = "See [ABC-123](https://other.example/ABC-123) and https://other.example/ABC-7.";
    expect(linkTickets(text, linked)).toBe(text);
  });

  it("leaves keys plain when no ticket address is set", () => {
    expect(linkTickets("Fails since ABC-123.", DEFAULT_PRESENTATION)).toBe("Fails since ABC-123.");
  });

  it("links no look alike inside a longer word", () => {
    expect(linkTickets("X-ABC-123 and ABC-123a stay.", linked)).toBe(
      "X-ABC-123 and ABC-123a stay.",
    );
  });

  it("links the reason of a comment and leaves its suggestion as code", () => {
    const body = renderCommentBody(finding, "abc", linked);
    expect(body).toContain(
      "The spec skips [ABC-123](https://tracker.example.com/browse/ABC-123) instead",
    );
    expect(body).toContain("`expectFailure(ABC-123)`");
    expect(body).toContain("expectFailure('ABC-123', 'team');");
  });

  it("links the key in a summary line", () => {
    const body = renderSummaryBody(
      {
        findings: [finding],
        proposals: [],
        droppedUncited: 0,
        filtered: 0,
        gate: evaluateGate([finding], "none"),
      },
      linked,
    );
    expect(body).toContain(": Failing test [ABC-123](https://tracker.example.com/browse/ABC-123)");
  });
});

describe("ticket configuration", () => {
  it("puts the key into the configured address", () => {
    const scm = { fileUrl: undefined } as unknown as ScmPort;
    const presentation = presentationFor(
      scm,
      {
        displayName: "Code review",
        guidelinesDir: "guidelines",
        targetBranch: "main",
        tickets: { url: TRACKER, pattern: PATTERN },
      },
      undefined,
      () => undefined,
    );
    expect(linkTickets("ABC-9", presentation)).toBe(
      "[ABC-9](https://tracker.example.com/browse/ABC-9)",
    );
  });

  it("rejects an address without {key} and a pattern that does not compile", () => {
    const parsed = ConfigSchema.safeParse({
      tickets: { url: "https://tracker.example.com", pattern: "[" },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toEqual([
      "tickets.url",
      "tickets.pattern",
    ]);
  });

  it("reads the address from the environment, unset by default", () => {
    const env = { DELTA_PEACOCK_TICKETS_URL: TRACKER };
    expect(loadConfig({ root: process.cwd(), env: {} }).tickets.url).toBeUndefined();
    expect(loadConfig({ root: process.cwd(), env }).tickets).toEqual({
      url: TRACKER,
      pattern: PATTERN,
    });
  });

  it("init writes the tickets block as a commented example that loads once uncommented", () => {
    const yaml = renderConfigYaml(DEFAULT_ANSWERS);
    const block = yaml.split("\n").filter((line) => /^# {0,3}(tickets:|url:|pattern:)/.test(line));
    expect(block).toHaveLength(3);
    const uncommented = parse(block.map((line) => line.slice(2)).join("\n")) as object;
    expect(ConfigSchema.parse(uncommented).tickets).toEqual({
      url: "https://tracker.example.com/browse/{key}",
      pattern: PATTERN,
    });
  });
});

describe("ticket links on a bitbucket pull request", () => {
  let fake: FakeBitbucket;

  beforeEach(async () => {
    fake = await startFakeBitbucket();
    fake.userEndpoint = "ok";
  });

  afterEach(async () => {
    await fake.close();
  });

  it("posts the comment with its key linked", async () => {
    const port = createBitbucketPort({
      repository: "ws/repo",
      pullRequest: 10,
      token: "test-token",
      baseUrl: fake.baseUrl,
    });
    await publishReview(port, {
      findings: [finding],
      proposals: [],
      droppedUncited: 0,
      filtered: 0,
      gate: evaluateGate([finding], "MAJOR"),
      commitStatus: false,
      presentation: {
        displayName: "Code review",
        guidelinesDir: "guidelines",
        targetBranch: "main",
        tickets: { url: TRACKER, pattern: PATTERN },
      },
      dryRun: false,
    });
    const comment = fake.comments.find((c) => c.inline !== undefined);
    expect(comment?.content.raw).toContain("[ABC-123](https://tracker.example.com/browse/ABC-123)");
  });
});
