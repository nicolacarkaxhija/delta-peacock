import { describe, expect, it } from "vitest";
import { ToolError } from "../src/errors.js";
import { compileCustomPatterns, redactDiff } from "../src/review/redact.js";

describe("redactDiff", () => {
  it.each([
    { name: "aws-access-key", secret: "AKIAIOSFODNN7EXAMPLE" },
    { name: "github-token", secret: `ghp_${"a1B2".repeat(9)}` },
    { name: "slack-token", secret: "xoxb-123456789012-abcdefghijkl" },
    { name: "api-key", secret: "sk-or-v1-FAKE-TEST-KEY-0000000000000000" },
    {
      name: "jwt",
      secret: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
    },
    { name: "bearer-token", secret: "Bearer abcdefghijklmnopqrstuvwxyz123456" },
    { name: "email", secret: "test.user@example.com" },
  ])("redacts and counts $name", ({ name, secret }) => {
    const { text, counts } = redactDiff(`+const value = "${secret}";\n`);
    expect(text).not.toContain(secret);
    expect(text).toContain(`[redacted:${name}]`);
    expect(counts[name]).toBe(1);
  });

  it("redacts a private key block spanning lines", () => {
    const block = `-----BEGIN RSA PRIVATE KEY-----\n+MIIEowIBAAKCAQEA\n+MOREKEYMATERIAL\n-----END RSA PRIVATE KEY-----`;
    const { text, counts } = redactDiff(block);
    expect(text).not.toContain("MIIEowIBAAKCAQEA");
    expect(counts["private-key-block"]).toBe(1);
  });

  it("leaves ordinary diffs untouched with empty counts", () => {
    const diff =
      "diff --git a/x b/x\nindex 3b18e512dba79e4c8300dd08aeb37f8e728b8dad..1234567 100644\n+const x = 1;\n";
    const { text, counts } = redactDiff(diff);
    expect(text).toBe(diff);
    expect(counts).toEqual({});
  });

  it("applies compiled custom patterns on top of the built-ins", () => {
    const custom = compileCustomPatterns([{ name: "acme-id", pattern: "ACME-\\d{6}" }]);
    const { text, counts } = redactDiff("+customer ACME-123456 registered\n", custom);
    expect(text).toContain("[redacted:acme-id]");
    expect(counts["acme-id"]).toBe(1);
  });

  it("aborts on a custom pattern that does not compile", () => {
    expect(() => compileCustomPatterns([{ name: "broken", pattern: "([" }])).toThrow(ToolError);
  });
});
