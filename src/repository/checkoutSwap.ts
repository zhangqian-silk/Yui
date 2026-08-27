import { existsSync } from "node:fs";
import { rename as defaultRename, rm as defaultRm } from "node:fs/promises";

/**
 * Filesystem ports for a managed-checkout swap. Injectable so the
 * rename-failure and rollback paths are deterministically testable;
 * production callers use the real `node:fs/promises` implementations.
 */
export type CheckoutSwapPorts = Readonly<{
  rename(sourcePath: string, targetPath: string): Promise<void>;
  remove(path: string): Promise<void>;
}>;

const realPorts: CheckoutSwapPorts = {
  rename: (sourcePath, targetPath) => defaultRename(sourcePath, targetPath),
  remove: (path) => defaultRm(path, { recursive: true, force: true })
};

export type CheckoutSwapRequest = Readonly<{
  /** The registered checkout path that must keep holding a valid repository. */
  currentPath: string;
  /** The prepared replacement checkout, promoted atomically into place. */
  stagingPath: string;
  /**
   * Sibling parking path for the previous checkout. Created by the swap and
   * removed by the caller only after the catalog side of the operation has
   * committed, so a crash anywhere in between stays recoverable.
   */
  backupPath: string;
}>;

/**
 * Heal the on-disk state of a crashed earlier swap before any new destructive
 * step runs. A backup next to a live checkout is a leftover from a completed
 * swap whose cleanup crashed and is removed; a backup without a live checkout
 * means the crash happened mid-swap, so the previous checkout is restored
 * intact. With no backup there is nothing to heal.
 */
export async function healCheckoutSwap(
  request: Pick<CheckoutSwapRequest, "currentPath" | "backupPath">,
  ports: CheckoutSwapPorts = realPorts
): Promise<void> {
  if (!existsSync(request.backupPath)) return;
  if (existsSync(request.currentPath)) {
    await ports.remove(request.backupPath);
    return;
  }
  await ports.rename(request.backupPath, request.currentPath);
}

/**
 * Promote a prepared staging checkout into the registered path without ever
 * leaving the registered path without a valid repository. The previous
 * checkout is moved to the backup path first; if the promotion fails it is
 * restored and the staging clone is removed. A crash between the two renames
 * is healed by {@link healCheckoutSwap} on the next run.
 */
export async function swapManagedCheckout(
  request: CheckoutSwapRequest,
  ports: CheckoutSwapPorts = realPorts
): Promise<void> {
  await healCheckoutSwap(request, ports);
  await ports.rename(request.currentPath, request.backupPath);
  try {
    await ports.rename(request.stagingPath, request.currentPath);
  } catch (error) {
    try {
      await ports.rename(request.backupPath, request.currentPath);
    } catch (rollbackError) {
      throw new Error(
        `Checkout swap failed and rollback was incomplete: ${messageOf(error)}; `
        + `rollback failed: ${messageOf(rollbackError)}. `
        + `The previous checkout remains parked at ${request.backupPath}.`
      );
    }
    await ports.remove(request.stagingPath).catch(() => {});
    throw error;
  }
}

/**
 * Restore the parked previous checkout after a committed swap had to be undone
 * (for example because the catalog transaction refused the change). The
 * promoted clone is discarded first; if the restore fails the parked checkout
 * stays recoverable through {@link healCheckoutSwap}.
 */
export async function restoreCheckoutSwap(
  request: Pick<CheckoutSwapRequest, "currentPath" | "backupPath">,
  ports: CheckoutSwapPorts = realPorts
): Promise<void> {
  await ports.remove(request.currentPath);
  await ports.rename(request.backupPath, request.currentPath);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
