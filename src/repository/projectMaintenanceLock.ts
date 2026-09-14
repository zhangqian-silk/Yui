import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { currentFileLockOwner, fileLockOwnerIsLive } from "../core/fileLockOwner.js";

/**
 * Per-Project maintenance fence.
 *
 * `project migrate` and Task archive cleanup are separate CLI processes that mutate a Project's
 * Git repository. Without coordination they can interleave with each other
 * and with the Controller's worktree preparation. The fence is an exclusive
 * directory under the Home's `locks/` area (O_EXCL via mkdir), so it works
 * for managed and external Projects alike and never touches the Project's
 * own checkout. A crashed holder is reclaimed once its owner process is
 * gone; the owner file records PID + process start time, so a recycled PID
 * can never pass for the original holder.
 *
 * Contenders wait asynchronously within one monotonic budget. Only lock
 * acquisition is retried; the caller's protected operation is never replayed.
 */
const PROJECT_MAINTENANCE_LOCK_TIMEOUT_MS = 60_000;
const PROJECT_MAINTENANCE_LOCK_RETRY_MIN_MS = 200;
const PROJECT_MAINTENANCE_LOCK_RETRY_MAX_MS = 500;
/** A lock older than this with a dead owner is reclaimed. */
const STALE_PROJECT_MAINTENANCE_LOCK_AGE_MS = 1_000;

/**
 * Raised when acquisition exhausted its budget. This acquisition has not
 * started the protected operation; callers retain responsibility for any
 * earlier effects and must not replay the whole operation implicitly.
 */
export class ProjectMaintenanceLockedError extends Error {
  readonly projectId: string;
  readonly retryable = true;
  constructor(projectId: string, readonly timeoutMs = PROJECT_MAINTENANCE_LOCK_TIMEOUT_MS) {
    super(`Timed out after ${timeoutMs}ms waiting for Project maintenance on ${projectId}; `
      + "the lock was not acquired. Read current state before retrying.");
    this.name = "ProjectMaintenanceLockedError";
    this.projectId = projectId;
  }
}

export class ProjectMaintenanceLockCancelledError extends Error {
  constructor(readonly projectId: string, cause: unknown) {
    super(`Cancelled waiting for Project maintenance on ${projectId}; the lock was not acquired.`, { cause });
    this.name = "ProjectMaintenanceLockCancelledError";
  }
}

/** Timing seams keep deadline/jitter checks deterministic without minute-long tests. */
export type ProjectMaintenanceLockOptions = Readonly<{
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  random?: () => number;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}>;

function acquisitionBudget(options: ProjectMaintenanceLockOptions) {
  const timeoutMs = options.timeoutMs ?? PROJECT_MAINTENANCE_LOCK_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError("Project maintenance timeout must be a finite nonnegative number.");
  }
  const now = options.now ?? (() => performance.now());
  return {
    timeoutMs,
    deadline: now() + timeoutMs,
    now,
    random: options.random ?? Math.random,
    wait: options.wait ?? ((milliseconds: number, signal?: AbortSignal) => delay(milliseconds, undefined, { signal })),
    signal: options.signal
  };
}

function assertNotCancelled(projectId: string, signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ProjectMaintenanceLockCancelledError(projectId, signal.reason);
}

/** Directory of one Project's maintenance fence, below the Home's locks area. */
export function projectMaintenanceLockPath(home: string, projectId: string): string {
  return join(home, "locks", "projects", `${projectId}.lock`);
}

/**
 * Acquire one Project's maintenance fence. Returns the release function;
 * callers MUST release on every exit path (try/finally). A live holder is
 * never stolen, including at timeout; a stale (dead) holder is reclaimed.
 *
 * There is no in-process reentrancy: every acquisition contends, so two
 * independent operations in the same process are mutually exclusive just
 * like two processes. Genuine lexical nesting (an operation that needs the
 * fence while its caller already holds it) goes through private
 * already-locked methods, never through a second acquisition.
 */
export function acquireProjectMaintenanceLock(
  home: string,
  projectId: string,
  options: ProjectMaintenanceLockOptions = {}
): Promise<() => void> {
  return acquireWithBudget(home, projectId, acquisitionBudget(options));
}

async function acquireWithBudget(
  home: string,
  projectId: string,
  budget: ReturnType<typeof acquisitionBudget>,
  firstProject = true
): Promise<() => void> {
  const lock = projectMaintenanceLockPath(home, projectId);
  assertNotCancelled(projectId, budget.signal);
  const ownerIdentity = currentFileLockOwner();
  mkdirSync(join(home, "locks", "projects"), { recursive: true, mode: 0o700 });
  let firstAttempt = firstProject;
  while (true) {
    assertNotCancelled(projectId, budget.signal);
    // Always try the first Project immediately, even for a zero-budget probe.
    // Every retry and subsequent Project shares the original deadline.
    if (!firstAttempt && budget.now() >= budget.deadline) {
      throw new ProjectMaintenanceLockedError(projectId, budget.timeoutMs);
    }
    firstAttempt = false;
    try {
      mkdirSync(lock, { mode: 0o700 });
      writeOwnerIdentity(lock, ownerIdentity);
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
      if (budget.now() >= budget.deadline) {
        throw new ProjectMaintenanceLockedError(projectId, budget.timeoutMs);
      }
      reclaimStaleProjectMaintenanceLock(lock);
      const remaining = budget.deadline - budget.now();
      if (remaining <= 0) throw new ProjectMaintenanceLockedError(projectId, budget.timeoutMs);
      const jitter = PROJECT_MAINTENANCE_LOCK_RETRY_MIN_MS
        + budget.random() * (PROJECT_MAINTENANCE_LOCK_RETRY_MAX_MS - PROJECT_MAINTENANCE_LOCK_RETRY_MIN_MS);
      try {
        await budget.wait(Math.min(jitter, remaining), budget.signal);
      } catch (waitError) {
        assertNotCancelled(projectId, budget.signal);
        throw waitError;
      }
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
export async function acquireProjectMaintenanceLocks(
  home: string,
  projectIds: Iterable<string>,
  options: ProjectMaintenanceLockOptions = {}
): Promise<() => void> {
  const budget = acquisitionBudget(options);
  const releases: Array<() => void> = [];
  try {
    for (const projectId of [...new Set(projectIds)].sort()) {
      releases.push(await acquireWithBudget(home, projectId, budget, releases.length === 0));
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
 * while a live or unverified process holds its lock. Only proven stale owners
 * read as unfenced; incomplete evidence never authorizes preparation.
 */
export function isProjectMaintenanceFenced(home: string, projectId: string): boolean {
  const lock = projectMaintenanceLockPath(home, projectId);
  try { return fileLockOwnerIsLive(lock); }
  catch { return true; }
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
    if (!isEnoent(error)) throw error;
    // Allow publication its initial grace period; an older missing owner is
    // diagnosed as unverified below, never treated as a dead creator.
    try {
      if (Date.now() - statSync(lock).mtimeMs < STALE_PROJECT_MAINTENANCE_LOCK_AGE_MS) return;
    } catch (statError) {
      if (isEnoent(statError)) return;
      throw statError;
    }
    expectedOwner = null;
  }
  try {
    if (Date.now() - statSync(lock).mtimeMs < STALE_PROJECT_MAINTENANCE_LOCK_AGE_MS) return;
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
        if (!isEnoent(error)) throw error;
        // Still ownerless: only reclaim when the initial read was also
        // ownerless. A non-null expectedOwner means another process wrote
        // the owner file between the two reads — leave its lock intact.
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
 * Reclaim a reclaim-lock directory only when it is provably orphaned: its
 * owner is provably dead AND it is older than the age bound, so a
 * lock whose owner just mkdir'ed but has not written its owner is not stolen.
 * Uses the same PID + start-time identity check as the main fence, so a
 * recycled PID with a different start identity does not keep an orphaned
 * reclaim lock alive. An ownerless or unreadable lock remains unverified.
 * Returns true when it removed the lock (caller retries), false otherwise.
 */
function reclaimOrphanedReclaimLock(reclaimLock: string): boolean {
  try {
    if (Date.now() - statSync(reclaimLock).mtimeMs < STALE_PROJECT_MAINTENANCE_LOCK_AGE_MS) return false;
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
