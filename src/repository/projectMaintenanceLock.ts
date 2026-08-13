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
 */
export function acquireProjectMaintenanceLock(home: string, projectId: string): () => void {
  const lock = projectMaintenanceLockPath(home, projectId);
  mkdirSync(join(home, "locks", "projects"), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + PROJECT_MAINTENANCE_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(
        join(lock, "owner"),
        `${process.pid}:${processStartIdentity() ?? ""}\n`,
        { mode: 0o600 }
      );
      let released = false;
      return () => {
        if (released) return;
        released = true;
        rmSync(lock, { recursive: true, force: true });
      };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      reclaimStaleProjectMaintenanceLock(lock);
      if (Date.now() >= deadline) throw new ProjectMaintenanceLockedError(projectId);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, PROJECT_MAINTENANCE_LOCK_RETRY_MS);
    }
  }
}

/**
 * Acquire the maintenance fence for several Projects in a stable (sorted)
 * order, so multi-Project maintenance can never deadlock against itself.
 * A failure releases every fence already taken.
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

function reclaimStaleProjectMaintenanceLock(lock: string): void {
  try {
    if (Date.now() - statSync(lock).mtimeMs < STALE_PROJECT_MAINTENANCE_LOCK_AGE_MS) return;
    if (lockOwnerIsAlive(lock)) return;
    rmSync(lock, { recursive: true, force: true });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) return;
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
