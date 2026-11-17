import { describe, expect, it } from "vitest";
import { ciHeadBranch, detectCi } from "../src/config/ci.js";
import { loadCredentials } from "../src/config/credentials.js";

describe("loadCredentials", () => {
  it("narrows raw env down to exactly the known credential names", () => {
    const credentials = loadCredentials({
      ANTHROPIC_API_KEY: "a",
      GITHUB_TOKEN: "g",
      DELTA_PEACOCK_MODEL_ID: "unrelated-config-var",
      SOME_OTHER_THING: "noise",
    });
    expect(credentials).toEqual({ ANTHROPIC_API_KEY: "a", GITHUB_TOKEN: "g" });
  });

  it("returns an empty object for an empty env", () => {
    expect(loadCredentials({})).toEqual({});
  });

  it("carries every credential name env defines, undefined ones omitted", () => {
    const credentials = loadCredentials({
      AWS_REGION: "eu-central-1",
      AWS_ACCESS_KEY_ID: "k",
      AWS_SECRET_ACCESS_KEY: "s",
      AWS_SESSION_TOKEN: "t",
      OPENROUTER_API_KEY: "or",
      OPENAI_API_KEY: "oa",
      BITBUCKET_TOKEN: "bb",
      GITLAB_TOKEN: "gl",
    });
    expect(credentials).toEqual({
      AWS_REGION: "eu-central-1",
      AWS_ACCESS_KEY_ID: "k",
      AWS_SECRET_ACCESS_KEY: "s",
      AWS_SESSION_TOKEN: "t",
      OPENROUTER_API_KEY: "or",
      OPENAI_API_KEY: "oa",
      BITBUCKET_TOKEN: "bb",
      GITLAB_TOKEN: "gl",
    });
  });
});

describe("detectCi", () => {
  it("reports no CI host for a plain local environment", () => {
    expect(detectCi({})).toBeUndefined();
  });

  it.each([
    { name: "github", env: { GITHUB_ACTIONS: "true" } },
    { name: "gitlab", env: { GITLAB_CI: "true" } },
    { name: "bitbucket", env: { BITBUCKET_BUILD_NUMBER: "12" } },
    { name: "jenkins", env: { JENKINS_URL: "http://jenkins.local" } },
  ])("detects $name from its own signal", ({ name, env }) => {
    expect(detectCi(env)).toBe(name);
  });

  it("prefers github when more than one signal is somehow present", () => {
    expect(detectCi({ GITHUB_ACTIONS: "true", GITLAB_CI: "true" })).toBe("github");
  });
});

describe("ciHeadBranch", () => {
  it.each([
    { env: {}, branch: undefined },
    { env: { GITHUB_HEAD_REF: "feature" }, branch: "feature" },
    { env: { GITHUB_REF_NAME: "main" }, branch: "main" },
    { env: { GITHUB_HEAD_REF: "feature", GITHUB_REF_NAME: "7/merge" }, branch: "feature" },
    { env: { GITHUB_HEAD_REF: "", GITHUB_REF_NAME: "main" }, branch: "main" },
    { env: { GITHUB_HEAD_REF: "", GITHUB_REF_NAME: "" }, branch: undefined },
  ])("reads $branch from $env", ({ env, branch }) => {
    expect(ciHeadBranch(env)).toBe(branch);
  });
});
