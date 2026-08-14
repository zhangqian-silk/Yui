import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";

/**
 * Per-Project maintenance fence.
 *
 * `project migrate`, Task workspace rebuild, legacy ref archive, and Task
 * archive cleanup are separate CLI processes that all mutate a Project's
 * Git repository. Without coordination they can interleave with each other
 * and with the Controller's worktree preparation. The fence is an exclusive
 * directory under the Home's `locks/` area (O_EXCL via mkdir), so it works
 * for managed and external Projects alike and never touches the Project's
 * own checkout. A crashed holder is reclaimed once its owner process is
 * gone; the owner file records PID + process start time, so a recycled PID
 * can never pass for the original holder.
 *
 * Maintenance operations are long-lived, so a contended fence fails fast
 * with a retryable error instead of blocking the CLI for seconds.
 */
const PROJECT_MAINTENANCE_LOCK_TIMEOUT_MS = 250;
const PROJECT_MAINTENANCE_LOCK_RETRY_MS = 10;
/** A lock older than this with a dead owner is reclaimed. */
const STALE_PROJECT_MAINTENANCE_LOCK_AGE_MS = 1_000;

/**
 * Raised when a Project's maintenance fence is already held. The caller
 * made no changes and is safe to retry once the holder finishes.
 */
export class ProjectMaintenanceLockedError extends Error {
  readonly projectId: string;
  readonly retryable = true;
  constructor(projectId: string) {
    super(`Project maintenance is already in progress for ${projectId}; retry once it finishes.`);
    this.name = "ProjectMaintenanceLockedError";
    this.projectId = projectId;
  }
}

/** Directory of one Project's maintenance fence, below the Home's locks area. */
export function projectMaintenanceLockPath(home: string, projectId: string): string {
  return join(home, "locks", "projects", `${projectId}.lock`);
}

/**
 * Acquire one Project's maintenance fence. Returns the release function;
 * callers MUST release on every exit path (try/finally). A live holder
 * fails fast with {@link ProjectMaintenanceLockedError}; a stale (dead)
 * holder is reclaimed.
 *
 * There is no in-process reentrancy: every acquisition contends, so two
 * independent operations in the same process are mutually exclusive just
 * like two processes. Genuine lexical nesting (an operation that needs the
 * fence while its caller already holds it) goes through private
 * already-locked methods, never through a second acquisition.
 */
export function acquireProjectMaintenanceLock(home: string, projectId: string): () => void {
  const lock = projectMaintenanceLockPath(home, projectId);
  mkdirSync(join(home, "locks", "projects"), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + PROJECT_MAINTENANCE_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      const ownerIdentity = writeOwnerIdentity(lock);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        // Release only the exact acquired instance: a lock that was reclaimed
        // and replaced by a successor after a crash is never deleted by a
        // stale release handle.
        releaseOwnedProjectMaintenanceLock(lock, ownerIdentity);
      };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      reclaimStaleProjectMaintenanceLock(lock);
      if (Date.now() >= deadline) throw new ProjectMaintenanceLockedError(projectId);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, PROJECT_MAINTENANCE_LOCK_RETRY_MS);
    }
  }
}

/** Write this process's owner identity and return the exact bytes recorded. */
function writeOwnerIdentity(lock: string): string {
  const identity = `${process.pid}:${processStartIdentity() ?? ""}`;
  writeFileSync(join(lock, "owner"), `${identity}\n`, { mode: 0o600 });
  return identity;
}

/**
 * Remove the lock directory only when its owner file still records the exact
 * identity this handle acquired. A replaced (successor) lock is left intact.
 */
function releaseOwnedProjectMaintenanceLock(lock: string, ownerIdentity: string): void {
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
 * Acquire the maintenance fence for several Projects in a stable (sorted)
 * order, so multi-Project maintenance can never deadlock against itself.
 * A failure releases every fence already taken. Every Project contends,
 * including ones this process already holds: callers that need nesting must
 * use an already-locked private path instead of acquiring twice.
 */
export function acquireProjectMaintenanceLocks(
  home: string,
  projectIds: Iterable<string>
): () => void {
  const releases: Array<() => void> = [];
  try {
    for (const projectId of [...new Set(projectIds)].sort()) {
      releases.push(acquireProjectMaintenanceLock(home, projectId));
    }
  } catch (error) {
    for (const release of releases.reverse()) release();
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const release of releases.reverse()) release();
  };
}

/**
 * Non-blocking fence check for the Controller: a Project is fenced only
 * while a live process holds its lock. A stale (dead-owner) lock reads as
 * unfenced, so a crashed maintenance process never wedges preparation.
 */
export function isProjectMaintenanceFenced(home: string, projectId: string): boolean {
  const lock = projectMaintenanceLockPath(home, projectId);
  if (!existsSync(lock)) return false;
  return lockOwnerIsAlive(lock);
}

/**
 * Reclaim a stale (dead-owner) lock through a crash-safe compare-and-delete
 * critical section. Two contenders can both observe the same dead owner;
 * without serialization the second could rmSync the successor lock the first
 * created after reclaiming, admitting two holders. A reclaim lock (itself
 * reclaimable) serializes reclaimers, and under it we re-read the owner and
 * delete only when it is still the exact stale instance observed above.
 */
function reclaimStaleProjectMaintenanceLock(lock: string): void {
  let expectedOwner: string | null;
  try {
    expectedOwner = readFileSync(join(lock, "owner"), "utf8");
  } catch (error) {
    if (isEnoent(error)) return; // vanished; the caller retries the O_EXCL mkdir.
    throw error;
  }
  try {
    if (Date.now() - statSync(lock).mtimeMs < STALE_PROJECT_MAINTENANCE_LOCK_AGE_MS) return;
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  if (expectedOwner !== null && lockOwnerIsAlive(lock)) return;

  const reclaimLock = `${lock}.reclaim`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(reclaimLock, { mode: 0o700 });
    } catch (error) {
      if (!isEexist(error)) throw error;
      // Another reclaimer holds the critical section. Reclaim its lock only
      // when orphaned (dead owner and old enough), then retry once; a live
      // reclaimer will finish and the caller's next O_EXCL mkdir settles it.
      if (reclaimOrphanedReclaimLock(reclaimLock)) continue;
      return;
    }
    try {
      writeOwnerIdentity(reclaimLock);
      // Compare-and-delete under the lock: re-read and remove only the exact
      // stale instance observed above. A successor that replaced the lock has
      // different owner bytes (and a fresh mtime) and is never clobbered.
      let stat;
      try {
        stat = statSync(lock);
      } catch (error) {
        if (isEnoent(error)) return;
        throw error;
      }
      if (Date.now() - stat.mtimeMs < STALE_PROJECT_MAINTENANCE_LOCK_AGE_MS) return;
      let currentOwner: string | null;
      try {
        currentOwner = readFileSync(join(lock, "owner"), "utf8");
      } catch (error) {
        if (isEnoent(error)) return;
        throw error;
      }
      if (currentOwner !== expectedOwner) return;
      if (currentOwner !== null && lockOwnerIsAlive(lock)) return;
      rmSync(lock, { recursive: true, force: true });
    } finally {
      rmSync(reclaimLock, { recursive: true, force: true });
    }
    return;
  }
}

/**
 * Reclaim a reclaim-lock directory only when it is provably orphaned: its
 * owner pid is dead (or unrecorded) AND it is older than the age bound, so a
 * lock whose owner just mkdir'ed but has not written its pid is not stolen.
 * Returns true when it removed the lock (caller retries), false otherwise.
 */
function reclaimOrphanedReclaimLock(reclaimLock: string): boolean {
  try {
    if (Date.now() - statSync(reclaimLock).mtimeMs < STALE_PROJECT_MAINTENANCE_LOCK_AGE_MS) return false;
    let pid: number | null;
    try {
      pid = Number.parseInt(readFileSync(join(reclaimLock, "owner"), "utf8"), 10);
    } catch {
      pid = null; // no/unreadable owner on an old lock: treat as orphaned.
    }
    if (pid !== null && Number.isInteger(pid) && processIsAlive(pid)) return false;
    rmSync(reclaimLock, { recursive: true, force: true });
    return true;
  } catch (error) {
    return isEnoent(error);
  }
}

function lockOwnerIsAlive(lock: string): boolean {
  let owner: string;
  try {
    owner = readFileSync(join(lock, "owner"), "utf8").trim();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    // An unreadable owner file fails closed: treat the fence as held.
    return true;
  }
  const separator = owner.indexOf(":");
  const pid = Number.parseInt(separator < 0 ? owner : owner.slice(0, separator), 10);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const recordedIdentity = separator < 0 ? "" : owner.slice(separator + 1);
  // PID + start-time identity: a recycled PID can never match the holder.
  const currentIdentity = processStartIdentity(pid);
  if (currentIdentity !== undefined) {
    return recordedIdentity !== "" && currentIdentity === recordedIdentity;
  }
  // Off /proc (non-Linux): fall back to liveness.
  return processIsAlive(pid);
}

/** Linux process start time (clock ticks since boot) for a PID; undefined off /proc. */
function processStartIdentity(pid: number = process.pid): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).split(" ");
    return fields[19] ?? "0"; // field 22: starttime
  } catch {
    return undefined;
  }
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
