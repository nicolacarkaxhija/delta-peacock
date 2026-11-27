import { randomUUID } from "node:crypto";
import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TRASH = "peacock-trash-";

/** The folder each test file works in; one left behind means its run never finished. */
const WORK = "peacock-test-";

/** Trash older than this belongs to a run whose teardown never came. */
export const STALE_MS = 6 * 60 * 60 * 1000;

/** Names the folders the test files of one run set aside for deletion. */
export function trashPrefix(run: string): string {
  return `${TRASH}${run}-`;
}

/** Age of a folder, or undefined when it vanished since it was listed. */
function ageOf(folder: string): number | undefined {
  try {
    return Date.now() - statSync(folder).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Deletes the trash of the given run, and any run's trash or work folder once it is stale. */
export function sweepTrash(
  parent: string,
  run: string | undefined,
  onListed: (name: string) => void = () => undefined,
): void {
  const ours = readdirSync(parent).filter(
    (entry) => entry.startsWith(TRASH) || entry.startsWith(WORK),
  );
  for (const name of ours) {
    onListed(name);
    const folder = path.join(parent, name);
    const age = ageOf(folder);
    if (age === undefined) continue;
    const mine = run !== undefined && name.startsWith(trashPrefix(run));
    if (mine || age > STALE_MS) rmSync(folder, { recursive: true, force: true });
  }
}

/** Sweeps stale leftovers, names this run for the workers, then deletes what its test files set aside. */
export default function setup(): () => void {
  const run = randomUUID().slice(0, 8);
  sweepTrash(tmpdir(), undefined);
  process.env["PEACOCK_TEST_RUN"] = run;
  return () => {
    sweepTrash(tmpdir(), run);
  };
}
