import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

// each test file makes its temporary folders in one folder of its own, removed when the file ends
const NAMES = ["TMPDIR", "TMP", "TEMP"] as const;
const saved = NAMES.map((name) => [name, process.env[name]] as const);
const root = mkdtempSync(path.join(tmpdir(), "peacock-test-"));
for (const name of NAMES) process.env[name] = root;

afterAll(() => {
  for (const [name, value] of saved) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});
