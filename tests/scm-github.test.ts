import { describe, expect, it } from "vitest";
import { NoPullRequestError, ToolError } from "../src/errors.js";
import { createGitHubPort } from "../src/scm/github.js";
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
  it("finds the open pull request of the branch into the base once and works against it", async () => {
    const fake = await startFakeGitHub();
    try {
      fake.openPulls.push({ number: 9, head: "acme:feature/a b", base: "release" });
      fake.openPulls.push({ number: 7, head: "acme:feature/a b", base: "main" });
      const port = onBranch(fake.baseUrl, "feature/a b");
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
      fake.openPulls.push({ number: 9, head: "acme:feature", base: "release" });
      const failure = onBranch(fake.baseUrl, "feature").listSummaryComments();
      await expect(failure).rejects.toBeInstanceOf(NoPullRequestError);
      await expect(failure).rejects.toThrow(
        "no pull request for this branch: feature into main; a pull request from a fork needs scm.pullRequest",
      );
      expect(fake.writes).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it("names every match and asks for the number when more than one pull request is open", async () => {
    const fake = await startFakeGitHub();
    try {
      fake.openPulls.push({ number: 7, head: "acme:feature", base: "main" });
      fake.openPulls.push({ number: 9, head: "acme:feature", base: "main" });
      const failure = onBranch(fake.baseUrl, "feature").listSummaryComments();
      await expect(failure).rejects.toBeInstanceOf(ToolError);
      await expect(failure).rejects.toThrow(
        "more than one open pull request for this branch: feature into main (#7, #9); set scm.pullRequest",
      );
      expect(fake.writes).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it.each([
    ["a 401", "acme/widgets", "lookup-secret", /GITHUB_TOKEN/],
    ["a 403", "acme/widgets", "rate-limited", /rate limit/],
    ["a 404", "acme/missing", "test-token", /404/],
  ])(
    "fails on %s from the lookup without printing the token",
    async (_label, repository, token, message) => {
      const fake = await startFakeGitHub();
      try {
        const failure = onBranch(fake.baseUrl, "feature", repository, token).listSummaryComments();
        await expect(failure).rejects.toThrow(message);
        await expect(failure).rejects.not.toThrow(token);
      } finally {
        await fake.close();
      }
    },
  );
});

function onBranch(
  baseUrl: string,
  branch: string,
  repository = "acme/widgets",
  token = "test-token",
) {
  return createGitHubPort({
    repository,
    branch,
    base: "main",
    token,
    baseUrl,
  });
}
