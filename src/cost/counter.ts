import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

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

function withLock(counterPath: string, update: () => void): void {
  const lockPath = `${counterPath}.lock`;
  let locked = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      locked = true;
      break;
    } catch {
      const waitUntil = Date.now() + 15;
      while (Date.now() < waitUntil) {
        // short spin; reviews record spend once, contention is rare and brief
      }
    }
  }
  try {
    update();
  } finally {
    /* v8 ignore next 5 -- unlock failure only leaves a stale lock the next writer overwrites */
    if (locked) {
      try {
        rmSync(lockPath, { force: true });
      } catch {
        // nothing sensible to do
      }
    }
  }
}

export function recordSpend(counterPath: string, month: string, amount: number): void {
  mkdirSync(path.dirname(counterPath), { recursive: true });
  // read-modify-write under a best-effort lock so parallel runs never drop spend
  withLock(counterPath, () => {
    const all = readAll(counterPath);
    all[month] = (all[month] ?? 0) + amount;
    writeFileSync(counterPath, `${JSON.stringify(all, null, 2)}\n`);
  });
}
