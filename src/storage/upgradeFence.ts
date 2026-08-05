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

/** Read the current fence record, or `null` when none is present or it is unreadable. */
export function readUpgradeFence(home: string): UpgradeFence | null {
  let raw: string;
  try {
    raw = readFileSync(fencePath(home), "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
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
    // A malformed fence is treated as a live fence with an unknown owner below.
  }
  return { schemaVersion: 1, ownerPid: -1, reason: "malformed fence", createdAt: "" };
}

/**
 * Refuse a write when a live upgrade fence owned by another process is present.
 * A fence owned by the current process, or by a process that is gone, never
 * blocks: the placer may re-pin under the lock, and a stale fence is reclaimed.
 */
export function assertHomeWritable(
  home: string,
  callerPid: number = process.pid
): void {
  const fence = readUpgradeFence(home);
  if (fence === null) return;
  if (fence.ownerPid === callerPid) return;
  if (fence.ownerPid > 0 && !processIsAlive(fence.ownerPid)) {
    // Stale fence from a crashed upgrade: reclaim it so writers proceed.
    clearUpgradeFence(home);
    return;
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

  // At most two attempts: the second only ever runs to retry after reclaiming a
  // dead owner's stale fence. A fresh race is settled by the first atomic create;
  // a live foreign owner fails immediately without a retry.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (tryCreateFenceExclusive(path, content)) {
      fsyncDirectory(dirname(path));
      return makeFenceRelease(home, ownerPid);
    }
    // The atomic create lost: a fence already exists. Decide purely from its
    // owner — never by overwriting, which would reintroduce the race.
    const existing = readUpgradeFence(home);
    if (existing === null) continue; // vanished between create and read; retry.
    if (existing.ownerPid === ownerPid) {
      // This process already owns the fence: idempotent re-entry.
      return makeFenceRelease(home, ownerPid);
    }
    if (existing.ownerPid > 0 && !processIsAlive(existing.ownerPid)) {
      // Provably-dead owner: reclaim the stale fence and retry the atomic create.
      clearUpgradeFence(home);
      continue;
    }
    // A live foreign owner, or an undeterminable/malformed fence (ownerPid <= 0):
    // another upgrade holds this Home. Fail closed with no coordination protocol.
    throw new UpgradeFenceError(existing.reason);
  }
  // Still contended after the bounded reclaim retry: fail closed rather than spin.
  throw new UpgradeFenceError(readUpgradeFence(home)?.reason ?? "upgrade fence contended");
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
