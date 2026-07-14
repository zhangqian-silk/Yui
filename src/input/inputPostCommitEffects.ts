import { pumpOperatorDeliveries } from "../operator/operatorDeliveryPump.js";
import { processLeaderInputWakeups } from "../scheduler/leaderInputWakeupService.js";
import type { TmuxManager } from "../tmux/tmuxManager.js";

/**
 * Runs only the durable external effects created by public task-input writes.
 * Call this only after the owning domain transaction has committed.
 */
export function runTaskInputPostCommitEffects(
  rootDir: string,
  taskArgs: readonly string[],
  tmux: TmuxManager,
  now: Date = new Date()
): void {
  if (taskArgs[0] !== "input") return;

  if (taskArgs[1] === "request") {
    pumpOperatorDeliveries(rootDir, tmux);
    return;
  }

  if (taskArgs[1] === "answer") {
    processLeaderInputWakeups(rootDir, tmux, now, { clock: () => new Date() });
  }
}
