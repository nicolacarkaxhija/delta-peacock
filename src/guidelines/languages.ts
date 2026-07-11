import picomatch from "picomatch";
import type { Guideline } from "../domain/guideline.js";

/** Language names guidelines may declare, mapped to the file extensions they cover. */
export const LANGUAGE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  javascript: [".js", ".mjs", ".cjs", ".jsx"],
  typescript: [".ts", ".tsx", ".mts", ".cts"],
  python: [".py"],
  java: [".java"],
  kotlin: [".kt", ".kts"],
  go: [".go"],
  rust: [".rs"],
  ruby: [".rb"],
  php: [".php"],
  csharp: [".cs"],
  c: [".c", ".h"],
  cpp: [".cpp", ".cc", ".hpp"],
  swift: [".swift"],
  scala: [".scala"],
  html: [".html", ".htm"],
  isml: [".isml"],
  css: [".css"],
  scss: [".scss", ".sass"],
  sql: [".sql"],
  shell: [".sh", ".bash"],
  yaml: [".yml", ".yaml"],
  json: [".json"],
  markdown: [".md"],
};

export function isKnownLanguage(name: string): boolean {
  return name.toLowerCase() in LANGUAGE_EXTENSIONS;
}

function matchesLanguages(languages: readonly string[], changedFiles: readonly string[]): boolean {
  if (languages.length === 0) return true;
  const extensions = new Set(
    languages.flatMap((language) => LANGUAGE_EXTENSIONS[language.toLowerCase()] ?? []),
  );
  return changedFiles.some((file) => {
    const dot = file.lastIndexOf(".");
    return dot !== -1 && extensions.has(file.slice(dot).toLowerCase());
  });
}

function matchesPaths(paths: readonly string[], changedFiles: readonly string[]): boolean {
  if (paths.length === 0) return true;
  const matcher = picomatch([...paths]);
  return changedFiles.some((file) => matcher(file));
}

/** A guideline applies when the change touches its declared languages and paths. */
export function appliesTo(guideline: Guideline, changedFiles: readonly string[]): boolean {
  return (
    matchesLanguages(guideline.languages, changedFiles) &&
    matchesPaths(guideline.paths, changedFiles)
  );
}
