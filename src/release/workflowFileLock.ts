import { randomUUID } from "node:crypto";
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Cross-process mutual exclusion for one workflow's engine runs. Each CLI
 * invocation is a fresh Node process, so an in-process map cannot coordinate
 * across processes; this lock lives under the FileTaskStore root instead.
 *
 * The lock is a directory created atomically with mkdir(2): its existence is
 * the lock, so a second acquirer fails with EEXIST while the first holds it.
 * The owner receipt (pid + unique fence token) is written to a temp name and
 * renamed into place, so a reader observes either no receipt or a complete
 * one. Incomplete metadata is never reclaimed as dead: a lock without a
 * complete, parseable receipt is treated as live (its owner may be between
 * the mkdir and the receipt rename), so the empty-file window of the old
 * O_EXCL file lock can never produce two owners. A complete receipt whose
 * process is dead is reclaimed.
 *
 * Release verifies the fence token before removing the directory, so a lock
 * that was legitimately transferred (a stale holder was reclaimed and a new
 * owner acquired) is never removed by a stale release closure.
 */
const WORKFLOW_LOCK_DIRECTORY = ".release-workflow-locks";
const OWNER_RECEIPT_NAME = "owner";
const DEFAULT_LOCK_TIMEOUT_MS = 600_000;
const DEFAULT_LOCK_RETRY_MS = 20;

type OwnerReceipt = Readonly<{ pid: number; token: string }>;

export type WorkflowFileLockOptions = Readonly<{
  /** How long to wait for a held lock before failing; defaults to 10 minutes. */
  timeoutMs?: number;
  /** Delay between acquire attempts; defaults to 20ms. */
  retryMs?: number;
}>;

export async function acquireWorkflowFileLock(
  rootDir: string,
  taskId: string,
  workflowId: string,
  options: WorkflowFileLockOptions = {}
): Promise<() => void> {
  const lockRoot = join(rootDir, WORKFLOW_LOCK_DIRECTORY);
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  const lockDir = join(lockRoot, `${sanitizeLockPart(taskId)}--${sanitizeLockPart(workflowId)}.lock`);
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_LOCK_RETRY_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      const token = writeOwnerReceipt(lockDir);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        // Only remove the lock we own: a receipt with another token means
        // the lock was transferred and a different owner now holds it.
        if (!receiptNamesOwner(lockDir, token)) return;
        rmSync(lockDir, { recursive: true, force: true });
      };
    } catch (error) {
      if (!isEExist(error)) throw error;
      reclaimDeadWorkflowLock(lockDir);
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for the release workflow lock: ${taskId}/${workflowId}.`
        );
      }
      // Yield to the event loop so a concurrent run in the same process can
      // progress while this one waits.
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}

/**
 * Writes the owner receipt atomically: a temp file inside the (already
 * exclusively owned) lock directory, renamed to the receipt name. A reader
 * therefore sees a complete receipt or none, never a partial one. A failure
 * here would strand the lock after our death (it could never be reclaimed
 * without a receipt), so the lock directory is removed and the error raised.
 */
function writeOwnerReceipt(lockDir: string): string {
  const token = randomUUID();
  const receipt: OwnerReceipt = { pid: process.pid, token };
  const temp = join(lockDir, `.owner.${token}.tmp`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, join(lockDir, OWNER_RECEIPT_NAME));
  } catch (error) {
    rmSync(lockDir, { recursive: true, force: true });
    throw error;
  }
  return token;
}

/**
 * The complete owner receipt, or null when the lock carries no complete
 * receipt (the owner may be mid-acquisition) or an unparseable one. Null
 * means "do not reclaim": incomplete metadata is never treated as dead.
 */
function readOwnerReceipt(lockDir: string): OwnerReceipt | null {
  let raw: string;
  try {
    raw = readFileSync(join(lockDir, OWNER_RECEIPT_NAME), "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const receipt = parsed as Record<string, unknown>;
    if (typeof receipt.pid !== "number" || !Number.isInteger(receipt.pid) || receipt.pid <= 0) {
      return null;
    }
    if (typeof receipt.token !== "string" || receipt.token.length === 0) return null;
    return { pid: receipt.pid, token: receipt.token };
  } catch {
    return null;
  }
}

function receiptNamesOwner(lockDir: string, token: string): boolean {
  return readOwnerReceipt(lockDir)?.token === token;
}

/**
 * Reclaims a lock whose owner process is dead. A lock without a complete
 * receipt is left alone: its owner may be between the mkdir and the receipt
 * rename, and reclaiming in that window would hand the pathname to a second
 * owner while the first still believes it holds the lock.
 *
 * The reclaim itself is serialized with an atomic marker created via
 * `linkSync`: only one process can create the marker, so a second reclaimer
 * cannot remove a lock that was already reclaimed and re-acquired by a
 * third process between the first reclaimer's receipt check and its delete.
 * The receipt is re-read under the marker so a transferred lock is never
 * removed.
 */
function reclaimDeadWorkflowLock(lockDir: string): void {
  const receipt = readOwnerReceipt(lockDir);
  if (receipt === null) return;
  if (processIsAlive(receipt.pid)) return;

  const markerPath = join(lockDir, ".reclaiming");
  const tempPath = join(lockDir, `.reclaiming.${process.pid}.${randomUUID()}.tmp`);
  try {
    const fd = openSync(tempPath, "wx", 0o600);
    try {
      writeFileSync(fd, `${process.pid}\n`, { mode: 0o600 });
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tempPath, markerPath);
    } catch (error) {
      if (!isEExist(error)) throw error;
      // A concurrent or crashed reclaim left a marker. If its process is
      // dead, the marker is stale: remove it and claim once.
      if (!isReclaimMarkerStale(markerPath)) return;
      rmSync(markerPath, { force: true });
      linkSync(tempPath, markerPath);
    }
  } catch (error) {
    rmSync(tempPath, { force: true });
    if (isEnoent(error)) return; // Lock directory was removed
    throw error;
  }

  try {
    // Re-read under the marker: the lock may have been transferred to a
    // live owner between our first read and the marker claim.
    const current = readOwnerReceipt(lockDir);
    if (current === null) return;
    if (current.token !== receipt.token) return;
    if (processIsAlive(current.pid)) return;
    rmSync(lockDir, { recursive: true, force: true });
  } finally {
    rmSync(markerPath, { force: true });
  }
}

function isReclaimMarkerStale(markerPath: string): boolean {
  try {
    const pid = parseInt(readFileSync(markerPath, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 && !processIsAlive(pid);
  } catch {
    return false;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isEperm(error);
  }
}

function isEExist(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: string }).code === "EEXIST";
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function isEperm(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: string }).code === "EPERM";
}

function sanitizeLockPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-");
}
