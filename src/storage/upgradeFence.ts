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

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeTextFileAtomically } from "./durableFile.js";

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
 */
export function placeUpgradeFence(
  home: string,
  options: Readonly<{ reason: string; createdAt: string; ownerPid?: number }>
): () => void {
  const ownerPid = options.ownerPid ?? process.pid;
  const existing = readUpgradeFence(home);
  if (existing !== null && existing.ownerPid !== ownerPid) {
    if (existing.ownerPid > 0 && processIsAlive(existing.ownerPid)) {
      throw new UpgradeFenceError(existing.reason);
    }
  }
  const fence: UpgradeFence = {
    schemaVersion: 1,
    ownerPid,
    reason: options.reason,
    createdAt: options.createdAt
  };
  mkdirSync(dirname(fencePath(home)), { recursive: true, mode: 0o700 });
  writeTextFileAtomically(fencePath(home), `${JSON.stringify(fence, null, 2)}\n`);
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
