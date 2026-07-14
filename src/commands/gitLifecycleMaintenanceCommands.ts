import { randomUUID } from "node:crypto";
import { usageError } from "../errors/cliError.js";
import { GitExactRefLifecycleCoordinator } from "../worktree/gitExactRefLifecycle.js";

const DEFAULT_RECOVERY_LEASE_MS = 60_000;

/**
 * Manual-only recovery surface for durable Git exact-ref effects. It accepts
 * no repository or ledger flags: those bindings must come from the persisted,
 * fenced lifecycle operation itself.
 */
export function runGitLifecycleMaintenanceCommand(
  args: string[],
  rootDir: string,
  options: {
    ownerId?: string;
    leaseMs?: number;
  } = {}
): string {
  if (args.length !== 2 || args[0] !== "git" || args[1] !== "recover") {
    throw usageError("Maintenance Git recovery usage: taskmux maintenance git recover");
  }
  const coordinator = new GitExactRefLifecycleCoordinator(rootDir);
  const recovered = coordinator.recover(
    options.ownerId ?? randomUUID(),
    options.leaseMs ?? DEFAULT_RECOVERY_LEASE_MS
  );
  const completed = recovered.filter((entry) => entry.status === "completed").length;
  const activeLeaseSkipped = recovered.filter(
    (entry) => entry.status === "active-lease-skipped"
  ).length;
  const notStartedSkipped = recovered.filter(
    (entry) => entry.status === "not-started-skipped"
  ).length;
  return `Git lifecycle recovery: ${completed} completed, ${activeLeaseSkipped} active-lease-skipped, ${notStartedSkipped} not-started-skipped.\n`;
}
