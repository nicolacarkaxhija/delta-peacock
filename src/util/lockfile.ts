import { rmSync, statSync, writeFileSync } from "node:fs";
import process from "node:process";

/** A lock older than this is presumed left by a holder that died mid-write. */
const STALE_MS = 10_000;
const MAX_ATTEMPTS = 40;
const SPIN_MS = 15;

export interface LockOptions {
  /** Age past which a held lock is reclaimed as abandoned. */
  staleMs?: number;
  /** How many acquire attempts before giving up. */
  attempts?: number;
  /** Backoff between attempts, in milliseconds. */
  spinMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Runs update() while holding a best-effort file lock, so parallel runs do not
 * interleave a read-modify-write. Contention is rare and brief (a review or a
 * stats append records once). Two rules keep the guarantee honest: a lock left
 * behind by a crashed holder is reclaimed once it goes stale, and a writer that
 * still cannot acquire the lock skips its update rather than racing and
 * clobbering a concurrent total. Retries back off with a real timer rather
 * than busy-spinning the event loop, so a contended lock never blocks
 * whatever else the process is doing. Returns whether the update ran.
 */
export async function withLock(
  targetPath: string,
  update: () => void,
  options: LockOptions = {},
): Promise<boolean> {
  const lockPath = `${targetPath}.lock`;
  const staleMs = options.staleMs ?? STALE_MS;
  const attempts = options.attempts ?? MAX_ATTEMPTS;
  const spinMs = options.spinMs ?? SPIN_MS;
  let locked = false;
  for (let attempt = 0; attempt < attempts && !locked; attempt += 1) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      locked = true;
    } catch {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          rmSync(lockPath, { force: true }); // crashed holder; take it over
          continue;
        }
      } catch {
        /* v8 ignore next 2 -- the lock vanished between the failed claim and the stat */
        // nothing to reclaim; fall through and retry
      }
      await sleep(spinMs);
    }
  }
  // never a read-modify-write without the lock: dropping one update is safer
  // than an unlocked write that can clobber a concurrent writer's total
  if (!locked) return false;
  try {
    update();
  } finally {
    /* v8 ignore next 5 -- a lost unlock only leaves a lock the next writer reclaims as stale */
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // nothing sensible to do
    }
  }
  return true;
}
