import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Tools whose presence we detect by config file alone, never by parsing them.
 * The value is the candidate filenames that signal the tool is configured here.
 */
const LINTER_FILES: Readonly<Record<string, readonly string[]>> = {
  biome: ["biome.json", "biome.jsonc"],
  checkstyle: ["checkstyle.xml"],
  eslint: [
    ".eslintrc",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.json",
    ".eslintrc.yml",
    ".eslintrc.yaml",
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    "eslint.config.ts",
  ],
  prettier: [
    ".prettierrc",
    ".prettierrc.json",
    ".prettierrc.js",
    ".prettierrc.cjs",
    ".prettierrc.yml",
    ".prettierrc.yaml",
    "prettier.config.js",
    "prettier.config.cjs",
  ],
  rubocop: [".rubocop.yml"],
  ruff: ["ruff.toml", ".ruff.toml"],
  stylelint: [".stylelintrc", ".stylelintrc.json", ".stylelintrc.js", "stylelint.config.js"],
};

/** Detected tool names, sorted, so the injected instruction is byte-stable. */
export function detectLinters(cwd: string): string[] {
  return Object.entries(LINTER_FILES)
    .filter(([, files]) => files.some((file) => existsSync(path.join(cwd, file))))
    .map(([tool]) => tool)
    .sort();
}

/** One stable prompt-prefix line; empty when nothing is detected. */
export function linterInstruction(tools: readonly string[]): string {
  if (tools.length === 0) return "";
  return `The following tools run in this repository and enforce their own rules; do not raise findings they already cover: ${tools.join(", ")}.`;
}
