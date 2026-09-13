import { roleSessionMayContinue } from "../executor/effectiveLaunch.js";
import { roleAgentSessionResumeMode } from "../executor/agentExecutor.js";
import type { SchedulerReconcileSelection, SchedulerStorePort, TmuxDeliveryPort } from "./ports.js";
import { isSchedulerTaskWorkspaceReady } from "./ports.js";
import { taskOwnsManagedWorkspace } from "../task/task.js";
import { hasImmediateWakeReason } from "./wakeReason.js";
import { providerRetryPending } from "../runtime/providerRetry.js";

export type LeaderWakeupProcessingResult = Readonly<{
  taskId: string;
  runId?: string;
  status: "dispatched" | "steered" | "skipped" | "failed";
  reason?: "aggregating" | "busy" | "waiting-input" | "unavailable" | "workspace-not-ready" | "state-changed" | "not-ready";
  error?: string;
}>;

export const LEADER_WAKE_AGGREGATION_MS = 60_000;

/** Deliver a durable mailbox notification, not an implicit execution assignment.
 * Acceptance settles only its claimed batch; no Agent report is required.
 */
export async function processLeaderWakeups(
  store: SchedulerStorePort, delivery: TmuxDeliveryPort, now: Date,
  selection?: SchedulerReconcileSelection
): Promise<LeaderWakeupProcessingResult[]> {
  const results: LeaderWakeupProcessingResult[] = [];
  const wakeups = store.listPendingWakeups().filter((wake) =>
    !selection?.blockedTaskIds?.has(wake.taskId)
    && (selection === undefined || selection.full || selection.taskIds.has(wake.taskId)));
  for (const wakeup of wakeups) {
    const task = store.getTask(wakeup.taskId);
    const role = store.getRole(wakeup.taskId, "leader");
    const base = { taskId: wakeup.taskId };
    if (task == null || !["active", "draft"].includes(task.status) || task.executionGate.state !== "enabled" || role === null) {
      results.push({ ...base, status: "skipped", reason: "unavailable" }); continue;
    }
    if (!isSchedulerTaskWorkspaceReady(task, store.getTaskWorkspace(task.id), task.status === "draft" ? "planning" : "execution")) {
      results.push({ ...base, status: "skipped", reason: "workspace-not-ready" }); continue;
    }
    if (!hasImmediateWakeReason(wakeup.reasons)
      && now.getTime() - Date.parse(wakeup.firstRequestedAt) < LEADER_WAKE_AGGREGATION_MS) {
      results.push({ ...base, status: "skipped", reason: "aggregating" }); continue;
    }
    if (task.status === "draft" && store.prepareDraftPlanning?.(task.id, now)) {
      results.push({ ...base, status: "skipped", reason: "not-ready" }); continue;
    }
    const sessions = store.getTaskRoleSessionSet?.(task.id, role.name) ?? null;
    const provider = sessions?.providerBinding;
    if (providerRetryPending(provider)) {
      results.push({ ...base, status: "skipped", reason: "not-ready" }); continue;
    }
    if (provider?.authority.owner === "human" || provider?.authority.owner === "unknown") {
      results.push({ ...base, status: "skipped", reason: "busy" }); continue;
    }
    // Claim inspection also settles a previously accepted receipt after a
    // Controller restart, before checking whether that native execution is busy.
    const notification = store.claimLeaderNotification(task.id, now);
    if (notification === null) {
      results.push({ ...base, status: "skipped", reason: "state-changed" }); continue;
    }
    if (notification.disposition !== "submit") {
      results.push({ ...base, status: "skipped", reason: "not-ready",
        ...(notification.disposition === "unknown" ? {
          error: `Notification acceptance is unknown; the fixed wake is retained and will not be replayed. `
            + `After establishing native quiescence, release only this claim with yui task wake resolve ${task.id} ${notification.wakeId} --reason <evidence>.`
        } : {}) }); continue;
    }
    let attempted = false;
    try {
      const session = store.getRoleSession(task.id, role.name, role.effective.agentId);
      const effective = session?.status === "active" ? session.effective : role.effective;
      if (session?.status === "active" && !roleSessionMayContinue(session.effective, role.effective)) {
        throw new Error("Leader Session configuration changed; explicitly apply it before notification delivery.");
      }
      const mode = sessions === null ? "new"
        : roleAgentSessionResumeMode(sessions, effective.agentId, effective);
      const prepared = await delivery.prepareRoleSession({
        taskId: task.id, roleName: role.name, agentId: effective.agentId,
        adapterId: effective.adapterId, effective, workspace: effective.workspace.root,
        ...(role.managedWorkspace === undefined ? {} : { managedWorkspace: role.managedWorkspace }),
        ...(task.status === "draft" || !taskOwnsManagedWorkspace(task)
          ? { workspaceFree: true as const } : {}),
        mode, ...(mode === "resume" && session?.nativeSessionId !== undefined
          ? { nativeSessionId: session.nativeSessionId } : {})
      });
      const ready = await delivery.waitUntilReady(prepared);
      attempted = true;
      const outcome = await delivery.sendOnce({
        delivery: ready, receiptId: notification.attemptId, notificationId: notification.wakeId,
        text: [
          `Yui Task notification: task=${task.id} wake=${notification.wakeId}.`,
          `Read current context: yui task context ${task.id} --json.`,
          `Read the fixed notification window: yui task wake show ${task.id} ${notification.wakeId}.`,
          "Read referenced result Messages in full before deciding their disposition.",
          "Follow the Leader Skill to advance outstanding Task work from these durable facts, or record the exact decision/authority needed.",
          "This is a notification, not an execution assignment. No separate final report is required.",
          "Reading context is not an acknowledgement that its requirements have been implemented."
        ].join("\n")
      });
      const accepted = outcome.status === "sent" || outcome.status === "already-sent";
      const disposition = accepted ? "accepted"
        : outcome.status === "delivery-unknown" ? "unknown"
        : outcome.status === "rejected" ? "rejected"
        : outcome.status === "pending" ? null : "deferred";
      if (disposition !== null) store.settleLeaderNotification(
        task.id, notification.attemptId, disposition, now, outcome.failure?.detail);
      results.push({ ...base, status: accepted ? "dispatched" : "skipped", reason: accepted ? undefined : "not-ready" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      store.settleLeaderNotification(task.id, notification.attemptId,
        attempted ? "unknown" : "deferred", now, detail);
      results.push({ ...base, status: "failed", reason: "not-ready", error: detail });
    } finally {
      delivery.forgetPrepared?.({ taskId: task.id, roleName: role.name });
    }
  }
  return results;
}
