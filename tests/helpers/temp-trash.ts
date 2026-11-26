import { randomUUID } from "node:crypto";
import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TRASH = "peacock-trash-";

/** Trash older than this belongs to a run whose teardown never came. */
export const STALE_MS = 6 * 60 * 60 * 1000;

/** Names the folders the test files of one run set aside for deletion. */
export function trashPrefix(run: string): string {
  return `${TRASH}${run}-`;
}

/** Deletes the trash of the given run, and any run's trash once it is stale. */
export function sweepTrash(
  parent: string,
  run: string | undefined,
  onListed: (name: string) => void = () => undefined,
): void {
  void onListed;
  const now = Date.now();
  for (const name of readdirSync(parent).filter((entry) => entry.startsWith(TRASH))) {
    const folder = path.join(parent, name);
    const mine = run !== undefined && name.startsWith(trashPrefix(run));
    if (mine || now - statSync(folder).mtimeMs > STALE_MS) {
      rmSync(folder, { recursive: true, force: true });
    }
  }
}

/** Sweeps stale trash, names this run for the workers, then deletes what its test files set aside. */
export default function setup(): () => void {
  const run = randomUUID().slice(0, 8);
  sweepTrash(tmpdir(), undefined);
  process.env["PEACOCK_TEST_RUN"] = run;
  return () => {
    sweepTrash(tmpdir(), run);
  };
}
