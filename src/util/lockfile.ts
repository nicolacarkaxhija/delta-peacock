import { rmSync, writeFileSync } from "node:fs";
import process from "node:process";

/**
 * Runs update() while holding a best-effort file lock, so parallel runs never
 * interleave a read-modify-write. Contention is rare and brief (a review or a
 * stats append records once), so a short spin is enough.
 */
export function withLock(targetPath: string, update: () => void): void {
  const lockPath = `${targetPath}.lock`;
  let locked = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      locked = true;
      break;
    } catch {
      const waitUntil = Date.now() + 15;
      while (Date.now() < waitUntil) {
        // short spin; contention is rare and brief
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
