import { describe, expect, it } from "vitest";
import { ToolError } from "../src/errors.js";
import { createGitHubPort, type GitHubPortOptions } from "../src/scm/github.js";
import { startFakeGitHub } from "./helpers/fake-github.js";
import { runScmContract } from "./helpers/scm-contract.js";

function portAgainst(baseUrl: string, token = "test-token") {
  return createGitHubPort({
    repository: "acme/widgets",
    pullRequest: 7,
    token,
    baseUrl,
  });
}

runScmContract("github", {
  async make() {
    const fake = await startFakeGitHub();
    return {
      port: portAgainst(fake.baseUrl),
      inline: () => fake.reviewComments,
      summaries: () => fake.issueComments,
      statuses: () => fake.statuses,
      close: () => fake.close(),
    };
  },
});

describe("github adapter errors", () => {
  it("rejects a malformed repository up front", () => {
    expect(() =>
      createGitHubPort({ repository: "not-a-repo", pullRequest: 1, token: "t" }),
    ).toThrow(ToolError);
  });

  it("defaults to the public api host when no base url is given", () => {
    const port = createGitHubPort({ repository: "acme/widgets", pullRequest: 1, token: "t" });
    expect(typeof port.listInlineComments).toBe("function");
  });

  it("maps bad credentials to an actionable error", async () => {
    const fake = await startFakeGitHub();
    try {
      await expect(portAgainst(fake.baseUrl, "wrong").listInlineComments()).rejects.toThrow(
        /GITHUB_TOKEN/,
      );
    } finally {
      await fake.close();
    }
  });

  it("names the rate limit when it is exhausted", async () => {
    const fake = await startFakeGitHub();
    try {
      await expect(portAgainst(fake.baseUrl, "rate-limited").listInlineComments()).rejects.toThrow(
        /rate limit/,
      );
    } finally {
      await fake.close();
    }
  });

  it("falls back to a generic error naming the status for anything else unexpected", async () => {
    const fake = await startFakeGitHub();
    try {
      await expect(portAgainst(fake.baseUrl, "teapot").listInlineComments()).rejects.toThrow(/418/);
    } finally {
      await fake.close();
    }
  });
});

describe("github pull request from the branch", () => {
  it("finds the open pull request of the branch once and works against it", async () => {
    const fake = await startFakeGitHub();
    try {
      fake.openPulls.push({ number: 7, head: "acme:feature/a b" });
      const port = createGitHubPort({
        repository: "acme/widgets",
        branch: "feature/a b",
        token: "test-token",
        baseUrl: fake.baseUrl,
      } as unknown as GitHubPortOptions);
      await port.createSummaryComment("hello");
      await port.postStatus("success", "ok");
      expect(fake.pullLookups).toEqual(["acme:feature/a b"]);
      expect(fake.issueComments.map((comment) => comment.body)).toEqual(["hello"]);
      expect(fake.statuses[0]?.targetUrl).toBe(`${fake.baseUrl}/acme/widgets/pull/7`);
      expect(port.commentUrl?.("5")).toBe(`${fake.baseUrl}/acme/widgets/pull/7#discussion_r5`);
    } finally {
      await fake.close();
    }
  });

  it("reports no pull request for this branch when none is open", async () => {
    const fake = await startFakeGitHub();
    try {
      const port = createGitHubPort({
        repository: "acme/widgets",
        branch: "feature",
        token: "test-token",
        baseUrl: fake.baseUrl,
      } as unknown as GitHubPortOptions);
      const failure = port.listSummaryComments();
      await expect(failure).rejects.toMatchObject({
        name: "NoPullRequestError",
        message: "no pull request for this branch: feature",
      });
      expect(fake.writes).toEqual([]);
    } finally {
      await fake.close();
    }
  });
});
