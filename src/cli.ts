#!/usr/bin/env node
import process from "node:process";
import { runCli } from "./run-cli.js";

process.exitCode = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});
