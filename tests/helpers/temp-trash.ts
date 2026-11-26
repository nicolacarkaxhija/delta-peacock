import { randomUUID } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Names the folders the test files of one run set aside for deletion. */
export function trashPrefix(run: string | undefined): string {
  return `peacock-trash-${run ?? "unknown"}-`;
}

/** Names this run for the workers, then deletes what its test files set aside, once at the end. */
export default function setup(): () => void {
  const run = randomUUID().slice(0, 8);
  process.env["PEACOCK_TEST_RUN"] = run;
  return () => {
    const parent = tmpdir();
    const prefix = trashPrefix(run);
    for (const name of readdirSync(parent).filter((entry) => entry.startsWith(prefix))) {
      rmSync(path.join(parent, name), { recursive: true, force: true });
    }
  };
}
