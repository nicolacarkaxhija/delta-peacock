import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { ContextInput, ContextProvider } from "./port.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", "vendor", "build"]);
const MAX_RESULT_CHARS = 4000;
const MAX_MATCHES = 40;
const MAX_FILE_BYTES = 512 * 1024;

function clip(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[clipped]` : text;
}

function textFilesUnder(root: string, limit = 2000): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (files.length >= limit) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= limit) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) walk(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  };
  walk(root);
  return files;
}

function scanRepo(
  cwd: string,
  matcher: (line: string) => boolean,
  label: (relPath: string, lineNumber: number, line: string) => string,
): string {
  const hits: string[] = [];
  for (const filePath of textFilesUnder(cwd)) {
    try {
      if (statSync(filePath).size > MAX_FILE_BYTES) continue;
      const relative = path.relative(cwd, filePath).replaceAll("\\", "/");
      const lines = readFileSync(filePath, "utf8").split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (line !== undefined && matcher(line)) {
          hits.push(label(relative, index + 1, line.trim()));
          if (hits.length >= MAX_MATCHES) return clip(hits.join("\n"));
        }
      }
    } catch {
      // unreadable files answer nothing rather than crashing a review
    }
  }
  return hits.length === 0 ? "no matches found" : clip(hits.join("\n"));
}

/**
 * On-demand context: the model asks, handlers answer from the checkout.
 * Every handler is guarded; a failure degrades to an unhelpful answer,
 * never a crashed review.
 */
export function createAgenticProvider(): ContextProvider {
  return {
    name: "agentic",
    systemContext: () => "",
    tools(input: ContextInput): ToolSet {
      const cwd = input.cwd;
      return {
        get_definition: tool({
          description: "Find where a symbol (function, class, type) is defined in the repository",
          inputSchema: z.object({ symbol: z.string().min(1) }),
          execute: ({ symbol }) => {
            const pattern = new RegExp(
              `\\b(?:function|class|const|let|def|interface|type|fn|struct)\\s+${symbol.replaceAll(/[^\w$]/g, "")}\\b`,
            );
            return Promise.resolve(
              scanRepo(
                cwd,
                (line) => pattern.test(line),
                (file, line, text) => `${file}:${String(line)}: ${text}`,
              ),
            );
          },
        }),
        find_references: tool({
          description: "List places a symbol is referenced across the repository",
          inputSchema: z.object({ symbol: z.string().min(1) }),
          execute: ({ symbol }) => {
            const cleaned = symbol.replaceAll(/[^\w$]/g, "");
            const pattern = new RegExp(`\\b${cleaned}\\b`);
            return Promise.resolve(
              scanRepo(
                cwd,
                (line) => pattern.test(line),
                (file, line, text) => `${file}:${String(line)}: ${text}`,
              ),
            );
          },
        }),
        read_file_range: tool({
          description: "Read a range of lines from a file in the repository",
          inputSchema: z.object({
            path: z.string().min(1),
            startLine: z.number().int().min(1),
            endLine: z.number().int().min(1),
          }),
          execute: ({ path: relPath, startLine, endLine }) => {
            try {
              const full = path.resolve(cwd, relPath);
              // path.relative catches prefix tricks like ../repo-secrets
              const relation = path.relative(path.resolve(cwd), full);
              if (relation.startsWith("..") || path.isAbsolute(relation))
                return Promise.resolve("path is outside the repository");
              const lines = readFileSync(full, "utf8").split("\n");
              const slice = lines.slice(startLine - 1, Math.min(endLine, startLine + 200));
              return Promise.resolve(clip(slice.join("\n")));
            } catch (error) {
              return Promise.resolve(`could not read: ${(error as Error).message}`);
            }
          },
        }),
        search: tool({
          description: "Search the repository for a literal text fragment",
          inputSchema: z.object({ text: z.string().min(2) }),
          execute: ({ text }) => {
            return Promise.resolve(
              scanRepo(
                cwd,
                (line) => line.includes(text),
                (file, line, matched) => `${file}:${String(line)}: ${matched}`,
              ),
            );
          },
        }),
      };
    },
  };
}
