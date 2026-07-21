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
  reason?: "busy" | "unavailable" | "workspace-not-ready" | "recovery-blocked" | "state-changed";
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
    let claimed = false;
    let run: ReturnType<typeof createAgentRun> | null = null;
    try {
      const mode = hasNativeSession(existingSession) ? "resume" : "new";
      const input = leaderWakeupInput(
        task.id,
        wakeup.reasons,
        store.getTaskBrief(task.id),
        store.listDecisions(task.id),
        store.listMilestones(task.id)
      );
      run = createAgentRun(
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
      const latestTask = store.getTask(task.id);
      if (latestTask === null || latestTask.status !== "active") {
        results.push({ taskId: task.id, status: "skipped", reason: "unavailable" });
        continue;
      }
      effectiveSession = validateReadySession(role.activeAgentId, existingSession, mode, ready.session);
      const claim = store.saveLeaderDispatch({ task, role, run, session: effectiveSession, wakeup, now });
      if (claim !== "claimed") {
        results.push({ taskId: task.id, status: "skipped", reason: claim });
        continue;
      }
      claimed = true;
      await delivery.sendOnce({
        delivery: ready,
        receiptId: `agent-run:${run.id}`,
        text: input
      });

      store.saveRoleRunDelivery({ task, role, run, session: effectiveSession, now });
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
        ...(claimed && run !== null ? { claimed: { run, wakeup } } : {}),
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

function leaderWakeupInput(
  taskId: string,
  reasons: readonly string[],
  brief: import("../brief/taskBrief.js").TaskBrief | null,
  decisions: readonly import("../decision/decision.js").Decision[],
  milestones: readonly import("../milestone/milestone.js").Milestone[]
): string {
  const lines: string[] = [
    `TaskMux wakeup reasons: ${reasons.join(", ")}.`
  ];
  if (brief !== null) {
    lines.push(`Objective: ${brief.objective}`);
    if (brief.currentFocus.trim().length > 0) {
      lines.push(`Current focus: ${brief.currentFocus}`);
    }
  }
  const activeDecisions = decisions.filter((d) => d.status === "active").slice(0, 3);
  if (activeDecisions.length > 0) {
    lines.push("Active decisions:");
    for (const decision of activeDecisions) {
      lines.push(`  - ${decision.title}`);
    }
  }
  const recentMilestones = [...milestones]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 3);
  if (recentMilestones.length > 0) {
    lines.push("Recent milestones:");
    for (const milestone of recentMilestones) {
      lines.push(`  - ${milestone.title}`);
    }
  }
  lines.push(
    `Inspect taskmux task show ${taskId}, taskmux task message list ${taskId}, taskmux task work list ${taskId}, taskmux task brief show ${taskId}, taskmux task decision list ${taskId}, and taskmux task milestone list ${taskId}; then continue Leader stewardship.`
  );
  return lines.join("\n");
}
