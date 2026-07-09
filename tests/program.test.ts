import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/index.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
  description: string;
};

function captureOutput(argv: string[]): { stdout: string; commanderCode: string } {
  const program = buildProgram();
  program.exitOverride();
  let stdout = "";
  program.configureOutput({
    writeOut: (text) => {
      stdout += text;
    },
  });
  let commanderCode = "";
  try {
    program.parse(argv, { from: "user" });
  } catch (error) {
    commanderCode = (error as { code: string }).code;
  }
  return { stdout, commanderCode };
}

describe("program", () => {
  it("is named after the package", () => {
    expect(buildProgram().name()).toBe(manifest.name);
  });

  it("prints the package version on --version", () => {
    const { stdout, commanderCode } = captureOutput(["--version"]);
    expect(stdout.trim()).toBe(manifest.version);
    expect(commanderCode).toBe("commander.version");
  });

  it("describes itself in --help", () => {
    const { stdout, commanderCode } = captureOutput(["--help"]);
    expect(stdout).toContain(manifest.description);
    expect(commanderCode).toBe("commander.helpDisplayed");
  });
});
