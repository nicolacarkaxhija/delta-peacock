import { createRequire } from "node:module";
import { Command } from "commander";

const require = createRequire(import.meta.url);
const manifest = require("../package.json") as {
  name: string;
  version: string;
  description: string;
};

export function buildProgram(): Command {
  return new Command(manifest.name).description(manifest.description).version(manifest.version);
}
