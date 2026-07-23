import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ContextInput, ContextProvider } from "./port.js";

export const SIGNATURE_PATTERNS: Readonly<Record<string, RegExp>> = {
  ".js": /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|const|let)\s+(\w+)/,
  ".ts":
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|const|let|interface|type|enum)\s+(\w+)/,
  ".py": /^\s*(?:def|class)\s+(\w+)/,
  ".go": /^\s*(?:func|type)\s+(\w+)/,
  ".java": /^\s*(?:public|private|protected)[\w\s<>,]*\s(\w+)\s*\(/,
  ".rb": /^\s*(?:def|class|module)\s+(\w+)/,
  ".php": /^\s*(?:function|class)\s+(\w+)/,
  ".rs": /^\s*(?:pub\s+)?(?:fn|struct|enum|trait)\s+(\w+)/,
};

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", "vendor", "build"]);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 2000;

interface FileSignatures {
  filePath: string;
  /** signature line text by symbol name */
  symbols: Map<string, string>;
  /** every identifier the file mentions, for reference scoring */
  tokens: Set<string>;
}

function sourceFilesUnder(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // an unreadable directory must not kill the default provider
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) walk(full);
      } else if (entry.isFile() && path.extname(entry.name) in SIGNATURE_PATTERNS) {
        files.push(full);
      }
    }
  };
  walk(root);
  return files;
}

function extractFileInfo(filePath: string): { symbols: Map<string, string>; tokens: Set<string> } {
  const pattern = SIGNATURE_PATTERNS[path.extname(filePath)];
  const symbols = new Map<string, string>();
  const tokens = new Set<string>();
  if (pattern === undefined || statSync(filePath).size > MAX_FILE_BYTES) {
    return { symbols, tokens };
  }
  const content = readFileSync(filePath, "utf8");
  for (const line of content.split("\n")) {
    const match = pattern.exec(line);
    const name = match?.[1];
    if (name !== undefined && !symbols.has(name)) symbols.set(name, line.trim());
  }
  for (const match of content.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]{2,})\b/g)) {
    tokens.add(String(match[1]));
  }
  return { symbols, tokens };
}

/** Identifier-shaped tokens in the changed lines of the diff. */
function diffSymbols(diff: string): Set<string> {
  const tokens = new Set<string>();
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") && !line.startsWith("-")) continue;
    for (const match of line.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]{2,})\b/g)) {
      tokens.add(String(match[1]));
    }
  }
  return tokens;
}

/**
 * A deterministic ranked signature map: which symbols the rest of the repo
 * defines that this change touches. Zero model calls (ADR 0004 cost posture).
 */
export function createRepoMapProvider(): ContextProvider {
  return {
    name: "repo_map",
    systemContext(input: ContextInput): string {
      const changed = new Set(input.changedFiles.map((file) => path.normalize(file)));
      const wanted = diffSymbols(input.diff);
      if (wanted.size === 0) return "";

      const candidates: FileSignatures[] = [];
      for (const filePath of sourceFilesUnder(input.cwd)) {
        const relative = path.normalize(path.relative(input.cwd, filePath));
        if (changed.has(relative)) continue;
        const { symbols, tokens } = extractFileInfo(filePath);
        if (symbols.size > 0 || tokens.size > 0) {
          candidates.push({ filePath: relative, symbols, tokens });
        }
      }

      // symbols defined nearly everywhere carry no signal
      const definitionCounts = new Map<string, number>();
      for (const candidate of candidates) {
        for (const name of candidate.symbols.keys()) {
          definitionCounts.set(name, (definitionCounts.get(name) ?? 0) + 1);
        }
      }
      const commonCutoff = Math.max(3, Math.floor(candidates.length * 0.25));
      const isSignal = (name: string): boolean =>
        wanted.has(name) && (definitionCounts.get(name) ?? 0) < commonCutoff;

      const ranked = candidates
        .map((candidate) => {
          const definedOverlap = [...candidate.symbols.keys()].filter(isSignal);
          const referencedOverlap = [...candidate.tokens].filter(
            (name) => isSignal(name) && !candidate.symbols.has(name),
          );
          return {
            candidate,
            definedOverlap,
            score: definedOverlap.length * 3 + referencedOverlap.length,
          };
        })
        .filter((entry) => entry.score > 0)
        .sort(
          (a, b) => b.score - a.score || a.candidate.filePath.localeCompare(b.candidate.filePath),
        );

      if (ranked.length === 0) return "";

      const lines: string[] = [
        "Signature map of related files elsewhere in the repository (read-only background):",
      ];
      for (const { candidate, definedOverlap } of ranked) {
        lines.push(`${candidate.filePath.replaceAll("\\", "/")}:`);
        const shown =
          definedOverlap.length > 0 ? definedOverlap : [...candidate.symbols.keys()].slice(0, 4);
        for (const name of shown) {
          lines.push(`  ${candidate.symbols.get(name) ?? name}`);
        }
      }
      return lines.join("\n");
    },
  };
}
