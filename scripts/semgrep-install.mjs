#!/usr/bin/env node
// Installs the semgrep package.json pins: the wheel for this platform, checked
// against its sha256, unpacked to the semgrep-core binary and an osemgrep link.
// Usage: node scripts/semgrep-install.mjs [--dir <path>]; prints the directory to put on PATH.

import console from "node:console";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { Buffer } from "node:buffer";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version, wheels } = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
).semgrep;
const at = process.argv.indexOf("--dir");
const dir =
  at === -1
    ? path.join(root, ".delta-peacock-cache", "semgrep", version)
    : path.resolve(process.argv[at + 1]);
const link = path.join(dir, "osemgrep");

if (existsSync(link)) {
  console.log(dir);
  process.exit(0);
}

const platform = `${process.platform}-${process.arch}`;
const wheel = wheels[platform];
if (wheel === undefined) {
  console.error(
    `no pinned semgrep wheel for ${platform}; pinned: ${Object.keys(wheels).join(", ")}`,
  );
  process.exit(1);
}

const response = await globalThis.fetch(wheel.url);
if (!response.ok) {
  console.error(`download failed: ${String(response.status)} ${wheel.url}`);
  process.exit(1);
}
const zip = Buffer.from(await response.arrayBuffer());
const digest = createHash("sha256").update(zip).digest("hex");
if (digest !== wheel.sha256) {
  console.error(`sha256 mismatch for ${wheel.url}: ${digest}, pinned ${wheel.sha256}`);
  process.exit(1);
}

// a wheel is a zip: walk its central directory and unpack the bin folder
const BIN = `semgrep-${version}.data/purelib/semgrep/bin/`;
const END = 0x06054b50;
let end = zip.length - 22;
while (end >= 0 && zip.readUInt32LE(end) !== END) end -= 1;
let entry = zip.readUInt32LE(end + 16);
const count = zip.readUInt16LE(end + 10);
for (let index = 0; index < count; index += 1) {
  const method = zip.readUInt16LE(entry + 10);
  const size = zip.readUInt32LE(entry + 20);
  const nameLength = zip.readUInt16LE(entry + 28);
  const skip = nameLength + zip.readUInt16LE(entry + 30) + zip.readUInt16LE(entry + 32);
  const local = zip.readUInt32LE(entry + 42);
  const name = zip.toString("utf8", entry + 46, entry + 46 + nameLength);
  entry += 46 + skip;
  if (!name.startsWith(BIN) || name.endsWith("/") || name.endsWith(".py")) continue;
  const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  const packed = zip.subarray(start, start + size);
  const target = path.join(dir, name.slice(BIN.length));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, method === 8 ? inflateRawSync(packed) : packed, { mode: 0o755 });
}
// semgrep-core acts as the semgrep CLI when it runs under the name osemgrep
symlinkSync("semgrep-core", link);
console.log(dir);
