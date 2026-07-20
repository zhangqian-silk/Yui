import { createHash } from "node:crypto";

import { createAgentRun } from "../run/agentRun.js";
import { recordLeaderFailure } from "./leaderFailure.js";
import { createLeaderRecoveryNotification } from "./operatorNotification.js";
import type {
  SchedulerRoleSession,
  SchedulerStorePort,
  TmuxDeliveryPort
} from "./ports.js";

export type LeaderWakeupProcessingResult = Readonly<{
  taskId: string;
  status: "dispatched" | "skipped" | "failed";
  reason?: "busy" | "unavailable" | "workspace-not-ready" | "recovery-blocked";
  error?: string;
}>;

export async function processLeaderWakeups(
  store: SchedulerStorePort,
  delivery: TmuxDeliveryPort,
  now: Date
): Promise<LeaderWakeupProcessingResult[]> {
  const results: LeaderWakeupProcessingResult[] = [];
  for (const wakeup of store.listPendingWakeups()) {
    const task = store.getTask(wakeup.taskId);
    const role = store.getRole(wakeup.taskId, "leader");
    if (task === null || task.status !== "active" || role === null) {
      results.push({ taskId: wakeup.taskId, status: "skipped", reason: "unavailable" });
      continue;
    }
    if (task.repositoryId !== undefined && task.cwd === undefined) {
      results.push({ taskId: task.id, status: "skipped", reason: "workspace-not-ready" });
      continue;
    }
    if (store.getLeaderFailure(task.id) !== null) {
      results.push({ taskId: task.id, status: "skipped", reason: "recovery-blocked" });
      continue;
    }

    // This check deliberately precedes every tmux operation. A pending wake is
    // durable state, not text that may be injected into a busy Agent composer.
    if (store.getActiveAgentRun(task.id, role.name) !== null) {
      results.push({ taskId: task.id, status: "skipped", reason: "busy" });
      continue;
    }

    const existingSession = store.getRoleSession(task.id, role.name);
    let effectiveSession: SchedulerRoleSession | null = existingSession;
    try {
      const mode = hasNativeSession(existingSession) ? "resume" : "new";
      const input = leaderWakeupInput(task.id, wakeup.reasons);
      const run = createAgentRun(
        store.nextAgentRunId(task.id),
        task.id,
        role.name,
        mode,
        input,
        now
      );
      const prepared = await delivery.prepareRoleSession({
        taskId: task.id,
        roleName: role.name,
        agentId: role.activeAgentId,
        adapterId: role.adapterId,
        mode,
        ...(mode === "resume" ? { nativeSessionId: existingSession!.nativeSessionId } : {})
      });
      const ready = await delivery.waitUntilReady(prepared);
      effectiveSession = validateReadySession(role.activeAgentId, existingSession, mode, ready.session);
      await delivery.sendOnce({
        delivery: ready,
        receiptId: wakeupReceiptId(wakeup.taskId, wakeup.requestCount, wakeup.lastRequestedAt),
        text: input
      });

      store.saveLeaderDispatch({ task, role, run, session: effectiveSession, now });
      // Clear only after the real Leader AgentRun and its fixed session have
      // been durably recorded by the store adapter.
      store.clearPendingWakeup(task.id);
      results.push({ taskId: task.id, status: "dispatched" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = `Leader dispatch failed: ${detail}`;
      store.saveLeaderDispatchFailure({
        task,
        role,
        session: effectiveSession,
        failure: recordLeaderFailure(
          task.id,
          effectiveSession?.nativeSessionId ?? "(unregistered)",
          message,
          now,
          store.getLeaderFailure(task.id)
        ),
        notification: createLeaderRecoveryNotification(
          task.id,
          message,
          now,
          store.getOperatorNotification(task.id)
        ),
        now
      });
      results.push({ taskId: task.id, status: "failed", error: message });
    }
  }
  return results;
}

function validateReadySession(
  activeAgentId: string,
  existing: SchedulerRoleSession | null,
  mode: "new" | "resume",
  session: SchedulerRoleSession | null
): SchedulerRoleSession | null {
  if (mode === "new" && session === null) return null;
  if (session === null) throw new Error("Leader resume returned no fixed native session.");
  if (session.agentId !== activeAgentId) {
    throw new Error(`Ready session belongs to another Agent: ${session.agentId}.`);
  }
  if (!hasNativeSession(session)) {
    throw new Error("Ready Leader session has no native session id.");
  }
  if (mode === "resume" && session.nativeSessionId !== existing?.nativeSessionId) {
    throw new Error("Leader resume changed the fixed native session id.");
  }
  return { ...session, status: "running" };
}

function hasNativeSession(
  session: SchedulerRoleSession | null
): session is SchedulerRoleSession & { nativeSessionId: string } {
  return session !== null &&
    typeof session.nativeSessionId === "string" &&
    session.nativeSessionId.trim().length > 0;
}

function leaderWakeupInput(taskId: string, reasons: readonly string[]): string {
  return [
    `TaskMux wakeup reasons: ${reasons.join(", ")}.`,
    `Inspect taskmux task show ${taskId}, taskmux task message list ${taskId}, and taskmux task work list ${taskId}; then continue Leader stewardship.`
  ].join(" ");
}

function wakeupReceiptId(taskId: string, requestCount: number, lastRequestedAt: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([taskId, requestCount, lastRequestedAt]))
    .digest("hex")
    .slice(0, 24);
  return `leader-wakeup:${digest}`;
}
