import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { DEFAULT_SKIP_DIRS, walkFiles } from "../util/walk.js";
import type { ContextInput, ContextProvider } from "./port.js";

const MAX_RESULT_CHARS = 4000;
const MAX_MATCHES = 40;
const MAX_FILE_BYTES = 512 * 1024;

function clip(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[clipped]` : text;
}

/** path.relative catches prefix tricks like ../repo-secrets. */
function isOutside(root: string, target: string): boolean {
  const relation = path.relative(root, target);
  return relation.startsWith("..") || path.isAbsolute(relation);
}

function textFilesUnder(root: string, limit = 2000): string[] {
  return walkFiles(root, { skipDirs: DEFAULT_SKIP_DIRS, maxFiles: limit });
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

/** Lines of body shown under a definition, and the most doc comment lines shown above it. */
const BODY_LINES = 20;
const DOC_LINES = 8;

const MODIFIER = "(?:public|private|protected|static|async|readonly|override|abstract|get|set)";

/**
 * A keyword declaration, a class member behind a modifier (`protected name(`),
 * or a bare member whose whole signature ends in `{` on one line; a call
 * statement matches none of the three.
 */
function definitionPattern(symbol: string): RegExp {
  const name = symbol.replaceAll(/[^\w$]/g, "");
  return new RegExp(
    [
      `\\b(?:function|class|const|let|def|interface|type|fn|struct)\\s+${name}\\b`,
      `^\\s*(?:${MODIFIER}\\s+)+#?${name}\\s*(?:<[^>]*>)?\\s*\\(`,
      `^\\s*#?${name}\\s*(?:<[^>]*>)?\\s*\\([^;]*\\)\\s*(?::[^;{]*)?\\{\\s*$`,
    ].join("|"),
  );
}

/** The comment block right above a line, nearest line last. */
function docAbove(lines: readonly string[], index: number): string[] {
  const doc: string[] = [];
  for (let at = index - 1; at >= 0 && doc.length < DOC_LINES; at -= 1) {
    const text = (lines[at] ?? "").trim();
    if (!/^(?:\/\/|\/\*|\*|#)/.test(text)) break;
    doc.unshift(lines[at] ?? "");
  }
  return doc;
}

/** Every definition of a symbol as its path and line, doc comment and first body lines. */
function definitionBlocks(cwd: string, symbol: string): string[] {
  const pattern = definitionPattern(symbol);
  const blocks: string[] = [];
  for (const filePath of textFilesUnder(cwd)) {
    try {
      if (statSync(filePath).size > MAX_FILE_BYTES) continue;
      const relative = path.relative(cwd, filePath).replaceAll("\\", "/");
      const lines = readFileSync(filePath, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!pattern.test(line)) return;
        const doc = docAbove(lines, index);
        const body = lines.slice(index, index + BODY_LINES);
        blocks.push(
          `${relative}:${String(index + 1 - doc.length)}\n${[...doc, ...body].join("\n")}`,
        );
      });
    } catch {
      // unreadable files answer nothing rather than crashing a review
    }
    if (blocks.length >= MAX_MATCHES) break;
  }
  return blocks;
}

/**
 * Each definition of a symbol with its doc comment and the first lines of its
 * body, so what a helper returns is visible without a second read.
 */
function definitionsOf(cwd: string, symbol: string): string {
  const blocks = definitionBlocks(cwd, symbol);
  return blocks.length === 0 ? "no matches found" : clip(blocks.join("\n\n"));
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
          description:
            "Find where a symbol (function, method, class, type) is defined in the repository; returns each definition with its doc comment and the start of its body",
          inputSchema: z.object({ symbol: z.string().min(1) }),
          execute: ({ symbol }) => Promise.resolve(definitionsOf(cwd, symbol)),
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
              if (isOutside(path.resolve(cwd), full))
                return Promise.resolve("path is outside the repository");
              // a committed symlink (say to /proc/self/environ) must never reach the model
              if (lstatSync(full).isSymbolicLink())
                return Promise.resolve("refusing to read a symlink");
              if (isOutside(realpathSync(cwd), realpathSync(full)))
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
