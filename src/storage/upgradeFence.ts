/**
 * The upgrade admission fence.
 *
 * A fence is a small marker file inside a Yui Home. While it exists and is owned
 * by a live process other than the caller, every authoritative writer — a
 * baseline `yui` CLI invocation *and* the per-home Controller alike — refuses to
 * begin a new write. This is the mechanism by which `yui upgrade`/`yui update`
 * stop new writes before quiescing and switching the store, without a broad
 * process kill or a TTL/idle heuristic.
 *
 * The fence is honored at the single storage write choke point
 * (`FileTaskStore` commit), so both the CLI and the Controller — which mutate
 * through the same store — observe it. Because the check lives in that shared
 * path, every writer built from this release forward enforces it; it cannot
 * retroactively bind an already-installed older binary, so the upgrade
 * orchestrator additionally drains the Controller and fails closed on any live
 * writer rather than relying on the fence alone. It never blocks reads, and it
 * never blocks the process that placed it (so the upgrade orchestrator can
 * re-pin the revision under the write lock). A fence whose owner process is gone
 * is stale and is reclaimed, mirroring the storage lock's dead-owner reclaim.
 */

import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync
} from "node:fs";
import { dirname, join } from "node:path";

/** Fence marker location, beside the Controller discovery file under `runtime/`. */
export const UPGRADE_FENCE_FILE = "runtime/upgrade.fence";

/** The persisted fence record. */
export type UpgradeFence = Readonly<{
  schemaVersion: 1;
  /** PID of the upgrade orchestrator that owns this fence. */
  ownerPid: number;
  /** Human-readable reason, surfaced to a refused writer. */
  reason: string;
  /** ISO timestamp the fence was placed. */
  createdAt: string;
}>;

/** Thrown when a writer is refused because an upgrade fence is in place. */
export class UpgradeFenceError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(
      "Yui storage is fenced for an in-progress upgrade; new writes are refused "
        + `(${reason}). Wait for the upgrade to finish, or if no upgrade is `
        + "running remove the stale fence and retry."
    );
    this.name = "UpgradeFenceError";
    this.reason = reason;
  }
}

function fencePath(home: string): string {
  return join(home, UPGRADE_FENCE_FILE);
}

/** Read the fence file's raw bytes at an exact path, or `null` when absent. */
function readFenceRaw(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

/**
 * Parse raw fence bytes into a record. A well-formed fence yields its fields; a
 * malformed/unparseable fence yields a sentinel `ownerPid: -1` "malformed fence"
 * so callers treat it as an undeterminable (fail-closed) live fence, never as
 * absent or reclaimable.
 */
function parseFence(raw: string): UpgradeFence {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value.schemaVersion === 1
      && Number.isInteger(value.ownerPid)
      && typeof value.reason === "string"
      && typeof value.createdAt === "string"
    ) {
      return {
        schemaVersion: 1,
        ownerPid: value.ownerPid as number,
        reason: value.reason,
        createdAt: value.createdAt
      };
    }
  } catch {
    // fall through to the malformed sentinel.
  }
  return { schemaVersion: 1, ownerPid: -1, reason: "malformed fence", createdAt: "" };
}

/** Read the current fence record, or `null` when none is present or it is unreadable. */
export function readUpgradeFence(home: string): UpgradeFence | null {
  const raw = readFenceRaw(fencePath(home));
  if (raw === null) return null;
  return parseFence(raw);
}

/**
 * Refuse a write when a live upgrade fence owned by another process is present.
 * A fence owned by the current process, or by a process that is gone, never
 * blocks: the placer may re-pin under the lock, and a stale (dead-owner) fence is
 * reclaimed. A stale fence is only cleared for the caller once the reclaim is
 * PROVEN complete — if it cannot be cleared, this fails closed rather than
 * falsely reporting the Home writable (R2-F4).
 */
export function assertHomeWritable(
  home: string,
  callerPid: number = process.pid
): void {
  const path = fencePath(home);
  const raw = readFenceRaw(path);
  if (raw === null) return;
  const fence = parseFence(raw);
  if (fence.ownerPid === callerPid) return;
  if (fence.ownerPid > 0 && !processIsAlive(fence.ownerPid)) {
    // Stale fence from a crashed upgrade: reclaim it with the crash-safe atomic
    // rename-aside (F4/R2-F4), then RE-VERIFY. We only permit the write if the
    // admission path is now clear of a blocking fence:
    //  - absent / owned by us / owned by a still-dead pid -> writable, and
    //  - a LIVE foreign owner that took the freed slot -> refuse.
    // If the stale fence is somehow still present (reclaim could not move it), we
    // do NOT return writable — fail closed.
    reclaimStaleFence(path, raw);
    const afterRaw = readFenceRaw(path);
    if (afterRaw === null) return; // reclaimed: path is free.
    const after = parseFence(afterRaw);
    if (after.ownerPid === callerPid) return;
    if (after.ownerPid > 0 && !processIsAlive(after.ownerPid) && afterRaw !== raw) {
      // A different dead-owner fence appeared (a racer's crashed attempt); it is
      // itself reclaimable, so the Home is not live-fenced. Permit.
      return;
    }
    // Either the SAME stale fence is still there (reclaim did not complete) or a
    // live/undeterminable owner now holds it: fail closed, never falsely writable.
    throw new UpgradeFenceError(after.reason);
  }
  throw new UpgradeFenceError(fence.reason);
}

/**
 * Place an upgrade fence owned by the current process and return a release
 * handle. The handle is idempotent and only removes a fence this process owns.
 *
 * Acquisition is a SINGLE atomic `O_CREAT | O_EXCL` create (P2-5): the kernel
 * guarantees exactly one of any number of concurrent entrants wins that create,
 * so there is no check-then-write window in which two upgraders both believe
 * they acquired. A loser reads the existing fence and either:
 *  - re-enters (it already owns the fence — idempotent), or
 *  - reclaims a PROVABLY-DEAD owner's stale fence and retries the atomic create
 *    once (a dead owner cannot be a live competitor), or
 *  - fails closed with {@link UpgradeFenceError} for a live foreign owner or an
 *    undeterminable/malformed fence.
 * There is no lease, heartbeat, or multi-round negotiation — just the one atomic
 * create plus a bounded dead-owner reclaim.
 */
export function placeUpgradeFence(
  home: string,
  options: Readonly<{ reason: string; createdAt: string; ownerPid?: number }>
): () => void {
  const ownerPid = options.ownerPid ?? process.pid;
  const fence: UpgradeFence = {
    schemaVersion: 1,
    ownerPid,
    reason: options.reason,
    createdAt: options.createdAt
  };
  const content = `${JSON.stringify(fence, null, 2)}\n`;
  const path = fencePath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  // At most a bounded number of attempts: each reclaim of a dead owner's stale
  // fence is followed by one more atomic-create try. A fresh race is settled by
  // the first atomic create; a live foreign owner fails immediately.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (tryCreateFenceExclusive(path, content)) {
      fsyncDirectory(dirname(path));
      return makeFenceRelease(home, ownerPid);
    }
    // The atomic create lost: a fence already exists. Decide purely from its
    // owner — never by overwriting, which would reintroduce the race.
    const rawExisting = readFenceRaw(path);
    if (rawExisting === null) continue; // vanished between create and read; retry.
    const existing = parseFence(rawExisting);
    if (existing.ownerPid === ownerPid) {
      // This process already owns the fence: idempotent re-entry.
      return makeFenceRelease(home, ownerPid);
    }
    if (existing.ownerPid > 0 && !processIsAlive(existing.ownerPid)) {
      // Provably-dead owner: reclaim the stale fence with a crash-safe atomic
      // rename-aside (F4). It moves ONLY the exact stale inode out of the
      // admission path — a racer that replaced it with a live fence is preserved,
      // and no persistent coordination lock is left to orphan and block future
      // reclaims. Then retry the atomic create against the freed path.
      reclaimStaleFence(path, rawExisting);
      continue;
    }
    // A live foreign owner, or an undeterminable/malformed fence (ownerPid <= 0):
    // another upgrade holds this Home. Fail closed with no coordination protocol.
    throw new UpgradeFenceError(existing.reason);
  }
  // Still contended after the bounded reclaim retries: fail closed rather than spin.
  throw new UpgradeFenceError(readUpgradeFence(home)?.reason ?? "upgrade fence contended");
}

/**
 * Reclaim a stale (dead-owner) fence: delete the fence file at `path` only if its
 * bytes still exactly equal `expectedRaw`, under a short critical section that is
 * itself CRASH-SAFE (R2-F4).
 *
 * The exclusion is a `mkdir` lock — but, mirroring the storage lock's
 * `reclaimDeadLock`, the lock records its owner pid and is itself reclaimable, so
 * a holder that crashes mid-critical-section cannot permanently orphan it and
 * strand admission. On contention we first try to reclaim an orphaned lock (dead
 * owner, or older than a small age bound), then retry; if the lock is genuinely
 * held by a live process we simply return (that live reclaimer will finish, and
 * the caller's next O_EXCL create settles the race).
 *
 * Correctness of the delete: inside the lock we RE-READ the fence and delete only
 * if the bytes are still the exact stale ones, so a racer that O_EXCL-created a
 * fresh live fence at `path` between our observe and the delete is never
 * clobbered. The single O_EXCL create in `placeUpgradeFence` remains the sole
 * winner-decider, so a reclaim never grants ownership by itself.
 */
function reclaimStaleFence(path: string, expectedRaw: string): void {
  const reclaimLock = `${path}.reclaim.lock`;
  const ownerFile = join(reclaimLock, "owner");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(reclaimLock); // atomic; EEXIST if another reclaimer holds it.
    } catch (error) {
      if (!isEexist(error)) throw error;
      // Contended: reclaim the lock only if it is orphaned (dead owner or too
      // old), then retry once. A live-held lock means another reclaimer is
      // actively working — leave it and let the O_EXCL create settle the race.
      if (reclaimOrphanedLock(reclaimLock, ownerFile)) continue;
      return;
    }
    try {
      writeFenceLockOwner(ownerFile);
      // Re-read UNDER the lock; delete only if still the exact stale bytes.
      const current = readFenceRaw(path);
      if (current !== null && current === expectedRaw) {
        rmSync(path, { force: true });
        fsyncDirectory(dirname(path));
      }
    } finally {
      rmSync(reclaimLock, { recursive: true, force: true });
    }
    return;
  }
}

/** Small age bound below which an orphaned-looking lock is given the benefit of the doubt. */
const RECLAIM_LOCK_MIN_AGE_MS = 1_000;

/**
 * Reclaim a reclaim-lock directory ONLY when it is provably orphaned: its owner
 * pid is dead (or unreadable) AND it is older than a small age bound (so a lock
 * whose owner just `mkdir`ed but has not yet written its pid is not stolen).
 * Returns true when it removed the lock (caller should retry), false otherwise.
 */
function reclaimOrphanedLock(reclaimLock: string, ownerFile: string): boolean {
  try {
    const age = Date.now() - statSync(reclaimLock).mtimeMs;
    if (age < RECLAIM_LOCK_MIN_AGE_MS) return false; // too fresh; owner may be mid-acquire.
    let pid: number | null;
    try {
      pid = Number.parseInt(readFileSync(ownerFile, "utf8"), 10);
    } catch {
      pid = null; // no/unreadable owner on an old lock: treat as orphaned.
    }
    if (pid !== null && Number.isInteger(pid) && processIsAlive(pid)) return false; // live holder.
    rmSync(reclaimLock, { recursive: true, force: true });
    return true;
  } catch (error) {
    // ENOENT: the lock vanished (holder released it) — retry the mkdir.
    return isEnoent(error);
  }
}

function writeFenceLockOwner(ownerFile: string): void {
  try {
    writeSync(
      openSync(ownerFile, constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC, 0o600),
      `${process.pid}\n`
    );
  } catch {
    // Best effort: without the owner pid the lock is still age-reclaimable, so a
    // failure to record it degrades to the age bound rather than orphaning.
  }
}

/**
 * Atomically create the fence file and write its content, failing (returning
 * `false`) iff the file already exists. The `O_EXCL` create is the single point
 * that decides a concurrent race; the owner bytes are written into the same
 * descriptor and fsynced before it is closed.
 */
function tryCreateFenceExclusive(path: string, content: string): boolean {
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600
    );
  } catch (error) {
    if (isEexist(error)) return false;
    throw error;
  }
  try {
    writeSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return true;
}

/** Build the idempotent release handle that only clears a fence this owner holds. */
function makeFenceRelease(home: string, ownerPid: number): () => void {
  return () => {
    const current = readUpgradeFence(home);
    if (current !== null && current.ownerPid === ownerPid) clearUpgradeFence(home);
  };
}

/** Unconditionally remove any fence marker (used by release and stale reclaim). */
export function clearUpgradeFence(home: string): void {
  rmSync(fencePath(home), { force: true });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isEexist(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

/**
 * fsync the directory holding the fence so a crash right after acquisition still
 * observes the fence on the next boot (the marker's whole purpose is durability
 * across an interrupted upgrade). Best-effort: a platform that cannot open a
 * directory for fsync must not fail the acquisition.
 */
function fsyncDirectory(directory: string): void {
  let descriptor: number;
  try {
    descriptor = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  } catch {
    return;
  }
  try {
    fsyncSync(descriptor);
  } catch {
    // Some filesystems reject fsync on a directory fd; the O_EXCL create already
    // committed the inode, so this is not fatal to correctness.
  } finally {
    closeSync(descriptor);
  }
}
