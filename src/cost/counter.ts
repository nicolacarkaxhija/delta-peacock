import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { withLock } from "../util/lockfile.js";

export function defaultCounterPath(): string {
  return path.join(homedir(), ".delta-peacock", "spend.json");
}

export function monthKey(date: Date): string {
  return `${String(date.getUTCFullYear())}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function readAll(counterPath: string): Record<string, number> {
  if (!existsSync(counterPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(counterPath, "utf8")) as Record<string, unknown>;
    const clean: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value)) clean[key] = value;
    }
    return clean;
  } catch {
    return {}; // an unreadable counter must never block or crash a review
  }
}

export function readMonthSpend(counterPath: string, month: string): number {
  return readAll(counterPath)[month] ?? 0;
}

export async function recordSpend(
  counterPath: string,
  month: string,
  amount: number,
): Promise<void> {
  mkdirSync(path.dirname(counterPath), { recursive: true });
  // read-modify-write under a best-effort lock; under extreme contention a
  // writer skips rather than clobber a concurrent total (see withLock)
  await withLock(counterPath, () => {
    const all = readAll(counterPath);
    all[month] = (all[month] ?? 0) + amount;
    writeFileSync(counterPath, `${JSON.stringify(all, null, 2)}\n`);
  });
}
