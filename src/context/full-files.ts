import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { approximateTokens, type ContextInput, type ContextProvider } from "./port.js";

const HEADER = "Full content of the changed files after the change (read-only background):";
/** Bytes sniffed for a NUL to call a file binary. */
const SNIFF_BYTES = 8000;
/** Files beyond this size are never read whole. */
const MAX_FILE_BYTES = 1024 * 1024;

interface ChangedText {
  file: string;
  lines: string[];
  tokens: number;
}

/** A changed file's post-change text, or undefined when deleted, outside cwd, binary or huge. */
function readChangedText(cwd: string, file: string): ChangedText | undefined {
  const root = path.resolve(cwd);
  const full = path.resolve(root, file);
  if (full !== root && !full.startsWith(`${root}${path.sep}`)) return undefined;
  let text: string;
  try {
    if (!statSync(full).isFile() || statSync(full).size > MAX_FILE_BYTES) return undefined;
    const bytes = readFileSync(full);
    if (bytes.subarray(0, SNIFF_BYTES).includes(0)) return undefined;
    text = bytes.toString("utf8");
  } catch {
    return undefined;
  }
  return {
    file: file.replaceAll("\\", "/"),
    lines: text.split("\n"),
    tokens: approximateTokens(text),
  };
}

function fence(file: string): string {
  return `=== ${file} ===`;
}

/** The leading lines that fit the budget, with a marker naming what was cut. */
function truncated(entry: ChangedText, budget: number): { body: string[]; cut: boolean } {
  const kept: string[] = [];
  let used = 0;
  for (const line of entry.lines) {
    const cost = approximateTokens(`${line}\n`);
    if (used + cost > budget) break;
    kept.push(line);
    used += cost;
  }
  const cut = entry.lines.length - kept.length;
  return cut === 0
    ? { body: kept, cut: false }
    : { body: [...kept, `[truncated: ${String(cut)} more lines not shown]`], cut: true };
}

/**
 * Injects every changed file whole, post-change side, text only. The budget
 * fills smallest first, so only the largest files get truncated.
 */
export function createFullFilesProvider(options: {
  maxTokens: number;
}): Omit<ContextProvider, "systemContext"> & { systemContext(input: ContextInput): string } {
  // what the last call injected, so the log shows the strategy ran and at what size
  let notice: string | undefined;
  return {
    name: "full_files",
    systemContext(input: ContextInput): string {
      const entries = input.changedFiles
        .map((file) => readChangedText(input.cwd, file))
        .filter((entry): entry is ChangedText => entry !== undefined)
        .sort((a, b) => a.tokens - b.tokens || a.file.localeCompare(b.file));
      if (entries.length === 0) {
        notice = "full_files context: no readable changed file to inject";
        return "";
      }
      let remaining = options.maxTokens - approximateTokens(`${HEADER}\n`);
      const sections: string[] = [HEADER];
      let cut = 0;
      for (const [index, entry] of entries.entries()) {
        const overhead = approximateTokens(`${fence(entry.file)}\n\n`) + 12;
        const share = Math.floor(remaining / (entries.length - index)) - overhead;
        if (share <= 0) {
          cut += 1;
          sections.push(
            fence(entry.file),
            `[truncated: ${String(entry.lines.length)} lines not shown]`,
          );
          continue;
        }
        const { body, cut: wasCut } = truncated(entry, share);
        if (wasCut) cut += 1;
        sections.push(fence(entry.file), ...body);
        remaining -= approximateTokens(`${[fence(entry.file), ...body].join("\n")}\n`);
      }
      const text = sections.join("\n");
      notice = `full_files context: ${String(entries.length)} changed file(s), about ${String(approximateTokens(text))} of ${String(options.maxTokens)} tokens, ${cut === 0 ? "none" : String(cut)} truncated`;
      return text;
    },
    notices: () => (notice === undefined ? [] : [notice]),
  };
}
