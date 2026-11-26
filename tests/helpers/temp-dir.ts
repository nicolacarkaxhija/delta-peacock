import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { trashPrefix } from "./temp-trash.js";

// each test file makes its temporary folders in one folder of its own, set aside when the file ends
const NAMES = ["TMPDIR", "TMP", "TEMP"] as const;
const saved = NAMES.map((name) => [name, process.env[name]] as const);
const parent = tmpdir();
const root = mkdtempSync(path.join(parent, "peacock-test-"));
for (const name of NAMES) process.env[name] = root;

afterAll(() => {
  for (const [name, value] of saved) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
  // a rename is instant under any load; the global teardown deletes what was set aside
  try {
    renameSync(
      root,
      path.join(parent, `${trashPrefix(process.env["PEACOCK_TEST_RUN"])}${path.basename(root)}`),
    );
  } catch {
    rmSync(root, { recursive: true, force: true });
  }
});
