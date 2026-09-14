import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { currentFileLockOwner, fileLockOwnerIsLive } from "../core/fileLockOwner.js";

/**
 * Short per-Task commit fence for artifact repositories.
 *
 * A single meaningful artifact update is: write file(s) → verify scope →
 * local commit. Two concurrent saves in the same Task repo must not interleave
 * their `git add`/`commit` steps, or one could sweep the other's staged paths
 * into the wrong commit, or race the expected-HEAD check. This fence serializes
 * the commit critical section for one Task.
 *
 * The Project maintenance fence waits asynchronously for longer operations.
 * An artifact save is short, so this synchronous critical section briefly
 * retries a contended fence before giving up. It otherwise shares the same
 * crash-safe design: an exclusive directory under the Home's `locks/` area
 * (O_EXCL via mkdir), an owner file recording PID + process start time so a
 * recycled PID can never pass for the original holder, and reclaim of a stale
 * (dead-owner) lock.
 */
const ARTIFACT_COMMIT_LOCK_TIMEOUT_MS = 5_000;
const ARTIFACT_COMMIT_LOCK_RETRY_MS = 15;
/** A lock older than this with a dead owner is reclaimed. */
const STALE_ARTIFACT_COMMIT_LOCK_AGE_MS = 2_000;

/**
 * Raised when a Task's artifact commit fence could not be acquired within the
 * retry window. The caller made no changes and is safe to retry.
 */
export class ArtifactCommitLockedError extends Error {
  readonly taskId: string;
  readonly retryable = true;
  constructor(taskId: string) {
    super(`Another artifact save is in progress for ${taskId}; retry once it finishes.`);
    this.name = "ArtifactCommitLockedError";
    this.taskId = taskId;
  }
}

/** Directory of one Task's artifact commit fence, below the Home's locks area. */
export function artifactCommitLockPath(home: string, taskId: string): string {
  return join(home, "locks", "task-artifacts", `${taskId}.lock`);
}

/**
 * Acquire one Task's artifact commit fence. Returns the release function;
 * callers MUST release on every exit path (try/finally). A live holder is
 * retried until the timeout, then fails with {@link ArtifactCommitLockedError};
 * a stale (dead) holder is reclaimed. There is no in-process reentrancy: every
 * acquisition contends.
 */
export function acquireArtifactCommitLock(home: string, taskId: string): () => void {
  const lock = artifactCommitLockPath(home, taskId);
  const ownerIdentity = currentFileLockOwner();
  mkdirSync(join(home, "locks", "task-artifacts"), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + ARTIFACT_COMMIT_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      writeOwnerIdentity(lock, ownerIdentity);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseOwnedArtifactCommitLock(lock, ownerIdentity);
      };
    } catch (error) {
      if (!isEexist(error)) throw error;
      reclaimStaleArtifactCommitLock(lock);
      if (Date.now() >= deadline) throw new ArtifactCommitLockedError(taskId);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ARTIFACT_COMMIT_LOCK_RETRY_MS);
    }
  }
}

/** Write this process's owner identity and return the exact bytes recorded. */
function writeOwnerIdentity(lock: string, identity = currentFileLockOwner()): string {
  writeFileSync(join(lock, "owner"), `${identity}\n`, { mode: 0o600 });
  return identity;
}

/**
 * Remove the lock directory only when its owner file still records the exact
 * identity this handle acquired. A replaced (successor) lock is left intact.
 */
function releaseOwnedArtifactCommitLock(lock: string, ownerIdentity: string): void {
  let owner: string;
  try {
    owner = readFileSync(join(lock, "owner"), "utf8").trim();
  } catch (error) {
    if (isEnoent(error)) return; // already gone; nothing to release.
    throw error;
  }
  if (owner !== ownerIdentity) return;
  rmSync(lock, { recursive: true, force: true });
}

/**
 * Reclaim a stale (dead-owner) lock through a crash-safe compare-and-delete
 * critical section, serialized by a reclaim lock so two contenders cannot both
 * delete a successor. Under the reclaim lock we re-read the owner and delete
 * only when it is still the exact stale instance observed above.
 */
function reclaimStaleArtifactCommitLock(lock: string): void {
  let expectedOwner: string | null;
  try {
    expectedOwner = readFileSync(join(lock, "owner"), "utf8");
  } catch (error) {
    if (!isEnoent(error)) throw error;
    // Allow publication its initial grace period; an older missing owner is
    // diagnosed as unverified below, never treated as a dead creator.
    try {
      if (Date.now() - statSync(lock).mtimeMs < STALE_ARTIFACT_COMMIT_LOCK_AGE_MS) return;
    } catch (statError) {
      if (isEnoent(statError)) return;
      throw statError;
    }
    expectedOwner = null;
  }
  try {
    if (Date.now() - statSync(lock).mtimeMs < STALE_ARTIFACT_COMMIT_LOCK_AGE_MS) return;
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  if (fileLockOwnerIsLive(lock)) return;

  const reclaimLock = `${lock}.reclaim`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(reclaimLock, { mode: 0o700 });
    } catch (error) {
      if (!isEexist(error)) throw error;
      if (reclaimOrphanedReclaimLock(reclaimLock)) continue;
      return;
    }
    try {
      writeOwnerIdentity(reclaimLock);
      let stat;
      try {
        stat = statSync(lock);
      } catch (error) {
        if (isEnoent(error)) return;
        throw error;
      }
      if (Date.now() - stat.mtimeMs < STALE_ARTIFACT_COMMIT_LOCK_AGE_MS) return;
      let currentOwner: string | null;
      try {
        currentOwner = readFileSync(join(lock, "owner"), "utf8");
      } catch (error) {
        if (!isEnoent(error)) throw error;
        if (expectedOwner !== null) return;
        currentOwner = null;
      }
      if (currentOwner !== expectedOwner) return;
      if (fileLockOwnerIsLive(lock)) return;
      rmSync(lock, { recursive: true, force: true });
    } finally {
      rmSync(reclaimLock, { recursive: true, force: true });
    }
    return;
  }
}

/**
 * Reclaim a reclaim-lock directory only with a proven dead generation and
 * after the age bound. Returns true when it removed
 * the lock (caller retries), false otherwise.
 */
function reclaimOrphanedReclaimLock(reclaimLock: string): boolean {
  try {
    if (Date.now() - statSync(reclaimLock).mtimeMs < STALE_ARTIFACT_COMMIT_LOCK_AGE_MS) return false;
    if (fileLockOwnerIsLive(reclaimLock)) return false;
    rmSync(reclaimLock, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (isEnoent(error)) return true;
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isEexist(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
