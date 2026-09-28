import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, inject } from "vitest";

// every temp directory of this file, child processes included, lands under one root
const fileRoot = path.join(inject("tempRunRoot"), `file-${crypto.randomUUID()}`);
mkdirSync(fileRoot, { recursive: true });
const NAMES = ["TMPDIR", "TEMP", "TMP"] as const;
const before = NAMES.map((name) => process.env[name]);
for (const name of NAMES) process.env[name] = fileRoot;

afterAll(() => {
  NAMES.forEach((name, index) => {
    const value = before[index];
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  });
  rmSync(fileRoot, { recursive: true, force: true, maxRetries: 3 });
});
