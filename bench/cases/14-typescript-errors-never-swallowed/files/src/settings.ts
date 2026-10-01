import { readFile } from "node:fs/promises";

export async function readSettings(file: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}
