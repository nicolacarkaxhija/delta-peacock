import { describe, expect, it } from "vitest";
import type { ScmPort } from "../../src/scm/port.js";

export interface ScmContractHarness {
  /** A fresh fake server plus an adapter pointed at it. */
  make(): Promise<{
    port: ScmPort;
    /** Direct handles into the fake's state for assertions. */
    inline: () => { id: number; body: string; path?: string; line?: number }[];
    summaries: () => { id: number; body: string }[];
    statuses: () => { state: string; description: string; context: string; sha: string }[];
    close: () => Promise<void>;
  }>;
}

/** Every SCM adapter must pass this suite unchanged. */
export function runScmContract(name: string, harness: ScmContractHarness): void {
  describe(`scm contract: ${name}`, () => {
    it("creates, lists (paginated), updates and deletes inline comments", async () => {
      const fake = await harness.make();
      try {
        for (let index = 0; index < 5; index += 1) {
          await fake.port.createInlineComment({
            body: `comment ${String(index)}`,
            path: "src/app.js",
            line: index + 1,
          });
        }
        // the fake serves two per page, so listing five proves pagination
        const listed = await fake.port.listInlineComments();
        expect(listed).toHaveLength(5);

        const first = listed[0];
        expect(first?.path).toBe("src/app.js");
        await fake.port.updateComment(first?.id ?? "", "updated body");
        expect(fake.inline().find((c) => String(c.id) === first?.id)?.body).toBe("updated body");

        await fake.port.deleteComment(first?.id ?? "");
        expect(fake.inline()).toHaveLength(4);
      } finally {
        await fake.close();
      }
    });

    it("creates and updates the summary comment", async () => {
      const fake = await harness.make();
      try {
        await fake.port.createSummaryComment("summary v1");
        const summaries = await fake.port.listSummaryComments();
        expect(summaries).toHaveLength(1);
        await fake.port.updateSummaryComment(summaries[0]?.id ?? "", "summary v2");
        expect(fake.summaries()[0]?.body).toBe("summary v2");
      } finally {
        await fake.close();
      }
    });

    it("posts a commit status on the pull request head", async () => {
      const fake = await harness.make();
      try {
        await fake.port.postStatus("failure", "Blocked: 2 major findings must be resolved");
        await fake.port.postStatus(
          "success",
          "No issues found in this change.",
          "Automated review",
        );
        const [unnamed, named] = fake.statuses();
        expect(unnamed?.state).toBe("failure");
        expect(unnamed?.context).toBe("Code review");
        expect(named?.context).toBe("Automated review");
        expect(unnamed?.sha.length).toBeGreaterThan(0);
      } finally {
        await fake.close();
      }
    });
  });
}
