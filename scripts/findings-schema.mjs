#!/usr/bin/env node
// The vendored copy of the engine's findings schema: check it against the engine's, refresh it,
// or validate a findings file with it.
// Usage: node scripts/findings-schema.mjs check|refresh <engine schema file, or - for stdin> [--vendored <file>]
//        node scripts/findings-schema.mjs validate <findings file> [--vendored <file>]

import console from "node:console";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";

const USAGE =
  "usage: node scripts/findings-schema.mjs check|refresh|validate <file, or - for stdin> [--vendored <file>]";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const at = args.indexOf("--vendored");
const vendored = at === -1 ? path.join(root, "schema/finding.schema.json") : args[at + 1];
const [command, source] = at === -1 ? args : args.slice(0, at);

function fail(message, code) {
  console.error(message);
  process.exit(code);
}

function read(file) {
  try {
    return readFileSync(file === "-" ? 0 : file, "utf8");
  } catch {
    return fail(`findings schema: cannot read ${file}`, 2);
  }
}

/** Key order and layout aside, so a reformatted schema still counts as the same. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

const same = (left, right) =>
  JSON.stringify(canonical(JSON.parse(left))) === JSON.stringify(canonical(JSON.parse(right)));

if (!["check", "refresh", "validate"].includes(command) || source === undefined) fail(USAGE, 2);

if (command === "check") {
  if (same(read(source), read(vendored))) {
    console.log("findings schema: in step");
  } else {
    fail(
      `findings schema: the vendored copy ${vendored} differs from the engine's; refresh it with the engine's \`findings schema\` output piped into: node scripts/findings-schema.mjs refresh -`,
      1,
    );
  }
} else if (command === "refresh") {
  const text = read(source);
  JSON.parse(text);
  writeFileSync(vendored, text.endsWith("\n") ? text : `${text}\n`);
  console.log(`findings schema: ${vendored} refreshed`);
} else {
  const validate = new Ajv({ allErrors: true }).compile(JSON.parse(read(vendored)));
  if (validate(JSON.parse(read(source)))) {
    console.log(`${source}: valid`);
  } else {
    const problems = validate.errors.map((error) => `${error.instancePath} ${error.message}`);
    fail(`${source}: ${problems.join("; ")}`, 1);
  }
}
