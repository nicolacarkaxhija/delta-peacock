#!/usr/bin/env node
// Installs the semgrep package.json pins; the logic lives in src/review/semgrep/install.ts.
// Usage: pnpm build, then node scripts/semgrep-install.mjs [--dir <path>]; prints the folder to put on PATH.

import console from "node:console";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { installSemgrep } = await import(path.join(root, "dist", "semgrep-install.js"));
const pins = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).semgrep;
const at = process.argv.indexOf("--dir");
const dir =
  at === -1
    ? path.join(root, ".delta-peacock-cache", "semgrep", pins.version)
    : path.resolve(process.argv[at + 1]);

const download = async (url) => {
  const response = await globalThis.fetch(url);
  if (!response.ok) throw new Error(`download failed: ${String(response.status)} ${url}`);
  return Buffer.from(await response.arrayBuffer());
};

try {
  console.log(
    await installSemgrep({ pins, platform: `${process.platform}-${process.arch}`, dir, download }),
  );
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
