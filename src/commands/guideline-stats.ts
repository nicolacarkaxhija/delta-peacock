import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { loadConfig } from "../config/loader.js";
import type { RuntimeDeps } from "../deps.js";
import type { Guideline } from "../domain/guideline.js";
import { LANGUAGE_EXTENSIONS } from "../guidelines/languages.js";
import { loadGuidelines } from "../guidelines/loader.js";
import { readRecords } from "../stats/record.js";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  "vendor",
  "build",
  ".delta-peacock-cache",
]);
const MAX_TREE_FILES = 50_000;

/** Repo-relative file paths, capped so a giant tree cannot stall the walk. */
export function treeFiles(cwd: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (files.length >= MAX_TREE_FILES) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          walk(path.join(dir, entry.name));
        }
        continue;
      }
      if (entry.isFile())
        files.push(path.relative(cwd, path.join(dir, entry.name)).replaceAll("\\", "/"));
    }
  };
  walk(cwd);
  return files;
}

/** A scope is stale when the guideline declares it but the tree has nothing in it. */
export function stalenessOf(
  guideline: Guideline,
  files: readonly string[],
): { stalePaths: boolean; staleLanguages: boolean } {
  const stalePaths =
    guideline.paths.length > 0 && !files.some((file) => picomatch([...guideline.paths])(file));
  const extensions = guideline.languages.flatMap(
    (language) => LANGUAGE_EXTENSIONS[language.toLowerCase()] ?? [],
  );
  const staleLanguages =
    extensions.length > 0 && !files.some((file) => extensions.some((ext) => file.endsWith(ext)));
  return { stalePaths, staleLanguages };
}

interface GuidelineCoverage {
  id: string;
  fires: number;
  lastFired?: string;
  stalePaths: boolean;
  staleLanguages: boolean;
}

function coverageLine(entry: GuidelineCoverage): string {
  const flags: string[] = [];
  if (entry.fires === 0) flags.push("never fired");
  if (entry.stalePaths) flags.push("stale paths (no matching file)");
  if (entry.staleLanguages) flags.push("stale languages (no matching file)");
  const last = entry.lastFired !== undefined ? `, last ${entry.lastFired}` : "";
  const note = flags.length > 0 ? `  [${flags.join("; ")}]` : "";
  return `${entry.id}: ${String(entry.fires)} fire(s)${last}${note}`;
}

function renderCoverage(coverage: readonly GuidelineCoverage[]): string {
  const lines = ["Guideline coverage:", ""];
  if (coverage.length === 0) lines.push("no guidelines found");
  else for (const entry of coverage) lines.push(coverageLine(entry));
  lines.push("");
  return lines.join("\n");
}

export interface GuidelineStatsOptions {
  report?: string;
}

export function runGuidelineStats(deps: RuntimeDeps, options: GuidelineStatsOptions): number {
  const config = loadConfig({ root: deps.cwd, env: deps.env });
  const loaded = loadGuidelines(path.join(deps.cwd, config.review.guidelinesDir));
  for (const problem of loaded.problems) deps.err(`guideline skipped: ${problem}\n`);

  const fires = new Map<string, number>();
  const lastFired = new Map<string, string>();
  for (const record of readRecords(deps.cwd, config.stats.path)) {
    for (const [id, count] of Object.entries(record.byGuideline)) {
      fires.set(id, (fires.get(id) ?? 0) + count);
      const previous = lastFired.get(id);
      if (previous === undefined || record.at > previous) lastFired.set(id, record.at);
    }
  }

  const files = treeFiles(deps.cwd);
  const coverage: GuidelineCoverage[] = loaded.guidelines.map((guideline) => {
    const staleness = stalenessOf(guideline, files);
    const last = lastFired.get(guideline.id);
    return {
      id: guideline.id,
      fires: fires.get(guideline.id) ?? 0,
      ...(last !== undefined ? { lastFired: last } : {}),
      ...staleness,
    };
  });
  coverage.sort((a, b) => b.fires - a.fires);
  deps.out(renderCoverage(coverage));

  if (options.report !== undefined) {
    writeFileSync(
      path.resolve(deps.cwd, options.report),
      `${JSON.stringify({ guidelines: coverage }, null, 2)}\n`,
    );
  }
  return 0;
}
