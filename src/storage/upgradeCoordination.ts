/**
 * Shared coordination boundary for durable runtime-hook admission and the
 * final Home snapshot/switch.
 *
 * The upgrade fence answers "may a new writer start?" but a writer that has
 * already passed that check can still be in the middle of its durable inbox
 * write.  This sibling lock supplies the missing linearization point:
 *
 *   inbox publish: acquire lock -> check fence/progress -> write -> release
 *   upgrade cutover: acquire lock -> check drain -> copy -> switch -> release
 *
 * The lock lives beside (not inside) the Home, so the home -> backup and
 * staging -> home renames cannot move it out from under a live holder.  It is
 * a short, non-reentrant-on-disk critical section with a bounded wait.  A
 * crashed holder leaves its directory behind; a later entrant may atomically
 * rename it aside only after the owner is provably dead (or an owner-less
 * directory has exceeded the conservative age bound).  No TTL is used to
 * evict a live owner, and a live/undeterminable holder fails closed.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { assertHomeWritable, UpgradeFenceError } from "./upgradeFence.js";
import { STORAGE_SCHEMA_FILE } from "./storageSchema.js";
import { switchProgressPath } from "./upgrade/switchProgress.js";

/** Sibling directory used for the shared inbox/cutover critical section. */
export function upgradeCoordinationLockPath(home: string): string {
  return `${home}.upgrade-coordination.lock`;
}

const COORDINATION_LOCK_TIMEOUT_MS = 5_000;
const COORDINATION_LOCK_RETRY_MS = 10;
const COORDINATION_LOCK_MIN_AGE_MS = 1_000;

/**
 * Run a synchronous operation at the shared admission/cutover boundary.
 *
 * The admission check is intentionally performed *after* acquiring the lock.
 * A hook that passed a check before an upgrade placed its fence either owns the
 * lock and finishes before cutover, or waits and receives an explicit
 * UpgradeFenceError after the cutover holder releases it.  There is no second
 * scan or retry protocol hidden in this helper. A staged updater child passes
 * its already-authenticated parent fence owner through this same boundary.
 */
export function withUpgradeCoordinationLock<T>(
  home: string,
  execute: () => T,
  fenceOwnerPid: number = process.pid
): T {
  const release = acquireUpgradeCoordinationLock(home);
  try {
    assertUpgradeAdmission(home, fenceOwnerPid);
    return execute();
  } finally {
    release();
  }
}

/**
 * Refuse admission when a foreign upgrade fence or an unresolved durable
 * switch-progress marker is present.  A marker is actionable only while the
 * filesystem corroborates a missing/uninitialized Home; a stale marker beside
 * an intact Home is safe to ignore, matching update's recovery probe and
 * avoiding a permanent post-promote hook deadlock.  A malformed marker with a
 * missing Home still fails closed because its recovery phase cannot be trusted.
 */
export function assertUpgradeAdmission(
  home: string,
  fenceOwnerPid: number = process.pid
): void {
  assertHomeWritable(home, fenceOwnerPid);
  const progressPath = switchProgressPath(home);
  if (!existsSync(progressPath)) return;
  const homeInitialized = existsSync(join(home, STORAGE_SCHEMA_FILE));
  if (!homeInitialized) {
    throw new UpgradeFenceError(
      "storage switch recovery is in progress; the Home is not yet safe for a new write"
    );
  }
  // A marker with an intact Home is stale relative to the filesystem (for
  // example, a best-effort marker-clear failure after promotion). Reads and
  // normal hook writes may proceed; update reports the marker only when
  // backup+missing-Home evidence corroborates an interrupted switch.
}

// A same-process nested call is safe because the critical section is synchronous
// and cannot interleave with another turn.  Cross-process ownership remains
// governed by the on-disk mkdir boundary.
const ownedLocks = new Map<string, { depth: number; release: () => void }>();

function acquireUpgradeCoordinationLock(home: string): () => void {
  const lock = upgradeCoordinationLockPath(home);
  const nested = ownedLocks.get(lock);
  if (nested !== undefined) {
    nested.depth += 1;
    return () => releaseNested(lock, nested);
  }

  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + COORDINATION_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      try {
        writeFileSync(`${lock}/owner`, `${process.pid}\n`, { mode: 0o600 });
      } catch (error) {
        rmSync(lock, { recursive: true, force: true });
        throw error;
      }
      const release = () => releaseOwnedLock(lock, process.pid);
      ownedLocks.set(lock, { depth: 1, release });
      return release;
    } catch (error) {
      if (!isEexist(error)) throw error;
      if (reclaimStaleCoordinationLock(lock)) continue;
      if (Date.now() >= deadline) {
        throw new UpgradeFenceError(
          "shared inbox/cutover coordination is held by another process; retry after it exits"
        );
      }
      // Match the bounded wait used by the existing storage lock.  This is
      // contention backoff, not a correctness delay or a blind retry of a
      // publish/switch operation.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, COORDINATION_LOCK_RETRY_MS);
    }
  }
}

function releaseNested(lock: string, owned: { depth: number; release: () => void }): void {
  owned.depth -= 1;
  if (owned.depth === 0) {
    ownedLocks.delete(lock);
    owned.release();
  }
}

function releaseOwnedLock(lock: string, ownerPid: number): void {
  const current = readOwnerPid(lock);
  // Never remove a successor's lock if a stale release races with recovery.
  if (current === ownerPid) rmSync(lock, { recursive: true, force: true });
}

/**
 * Move an orphaned lock aside atomically.  The directory is never deleted in
 * place while another process could be acquiring it: rename-aside gives the
 * next O_EXCL mkdir a clean path and preserves a live replacement.
 */
function reclaimStaleCoordinationLock(lock: string): boolean {
  let age: number;
  try {
    age = Date.now() - statSync(lock).mtimeMs;
  } catch (error) {
    return isEnoent(error);
  }
  if (age < COORDINATION_LOCK_MIN_AGE_MS) return false;

  const ownerPid = readOwnerPid(lock);
  if (ownerPid !== null && processIsAlive(ownerPid)) return false;

  const abandoned = `${lock}.reclaim-${process.pid}-${randomUUID()}`;
  try {
    renameSync(lock, abandoned);
    rmSync(abandoned, { recursive: true, force: true });
    return true;
  } catch (error) {
    // ENOENT means the holder released it (or another reclaimer won); retry the
    // mkdir.  Any other failure is undeterminable and therefore fail-closed.
    return isEnoent(error);
  }
}

function readOwnerPid(lock: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(`${lock}/owner`, "utf8").trim();
  } catch {
    return null;
  }
  if (!/^\d+$/.test(raw)) return null;
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function isEexist(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
