import { describe, expect, it } from "vitest";
import { ToolError } from "../src/errors.js";
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
});
