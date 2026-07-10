import { createRequire } from "node:module";
import { Command } from "commander";
import { loadConfig } from "./config/loader.js";

const require = createRequire(import.meta.url);
const manifest = require("../package.json") as {
  name: string;
  version: string;
  description: string;
};

export interface CliDeps {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  out: (text: string) => void;
  err: (text: string) => void;
}

export function buildProgram(deps: CliDeps): Command {
  const program = new Command(manifest.name)
    .description(manifest.description)
    .version(manifest.version);
  program.exitOverride();
  program.configureOutput({ writeOut: deps.out, writeErr: deps.err });

  program
    .command("config")
    .description("resolve and print the effective configuration")
    .action(() => {
      const config = loadConfig({ root: deps.cwd, env: deps.env });
      deps.out(`${JSON.stringify(config, null, 2)}\n`);
    });

  return program;
}
