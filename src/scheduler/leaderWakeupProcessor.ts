import { createAgentRun } from "../run/agentRun.js";
import { markYuiRunInput } from "../run/runIdentity.js";
import { taskRoleSessionTitle } from "../runtime/sessionTitle.js";
import { recordLeaderFailure } from "./leaderFailure.js";
import { createLeaderRecoveryNotification } from "./operatorNotification.js";
import type {
  PreparedRoleDelivery,
  SchedulerRoleSession,
  SchedulerReconcileSelection,
  SchedulerStorePort,
  TmuxDeliveryPort
} from "./ports.js";

export type LeaderWakeupProcessingResult = Readonly<{
  taskId: string;
  runId?: string;
  status: "dispatched" | "skipped" | "failed";
  reason?: "busy" | "waiting-input" | "unavailable" | "workspace-not-ready" | "recovery-blocked" | "state-changed" | "not-ready" | "delivery-uncertain";
  error?: string;
}>;

export async function processLeaderWakeups(
  store: SchedulerStorePort,
  delivery: TmuxDeliveryPort,
  now: Date,
  selection?: SchedulerReconcileSelection
): Promise<LeaderWakeupProcessingResult[]> {
  const results: LeaderWakeupProcessingResult[] = [];
  const wakeups = selection === undefined || selection.full
    ? store.listPendingWakeups()
    : [...selection.taskIds].flatMap((taskId) => {
        const wakeup = store.getPendingWakeup(taskId);
        return wakeup === null ? [] : [wakeup];
      });
  for (const wakeup of wakeups) {
    const task = store.getTask(wakeup.taskId);
    const role = store.getRole(wakeup.taskId, "leader");
    if (task === null || task.status !== "active" || role === null) {
      results.push({ taskId: wakeup.taskId, status: "skipped", reason: "unavailable" });
      continue;
    }
    if (task.projectBindings.length > 0 && task.cwd === undefined) {
      results.push({ taskId: task.id, status: "skipped", reason: "workspace-not-ready" });
      continue;
    }
    if (store.getLeaderFailure(task.id) !== null) {
      results.push({ taskId: task.id, status: "skipped", reason: "recovery-blocked" });
      continue;
    }
    if (store.hasOpenInputRequest(task.id)) {
      results.push({ taskId: task.id, status: "skipped", reason: "waiting-input" });
      continue;
    }

    // This check deliberately precedes every tmux operation. A pending wake is
    // durable state, not text that may be injected into a busy Agent composer.
    if (store.getActiveAgentRun(task.id, role.name) !== null) {
      results.push({ taskId: task.id, status: "skipped", reason: "busy" });
      continue;
    }
    if (typeof store.hasInFlightTurn === "function"
      && store.hasInFlightTurn(task.id, role.name)) {
      results.push({ taskId: task.id, status: "skipped", reason: "busy" });
      continue;
    }

    const existingSession = store.getRoleSession(task.id, role.name);
    let effectiveSession: SchedulerRoleSession | null = existingSession;
    let claimed = false;
    let deliveryAttempted = false;
    let run: ReturnType<typeof createAgentRun> | null = null;
    let prepared: PreparedRoleDelivery | undefined;
    try {
      const mode = hasNativeSession(existingSession) ? "resume" : "new";
      const runId = store.nextAgentRunId(task.id);
      const input = markYuiRunInput(leaderWakeupInput(
        task.id,
        runId,
        wakeup.reasons
      ), runId, taskRoleSessionTitle(task, role.name));
      run = createAgentRun(
        runId,
        task.id,
        role.name,
        mode,
        input,
        now,
        {
          agent: {
            agentId: role.activeAgentId,
            adapterId: role.adapterId,
            ...(role.model === undefined ? {} : { model: role.model }),
            ...(role.effort === undefined ? {} : { effort: role.effort })
          }
        }
      );
      const claim = store.saveLeaderDispatch({
        task,
        role,
        run,
        session: existingSession,
        wakeup,
        now
      });
      if (claim !== "claimed") {
        results.push({ taskId: task.id, status: "skipped", reason: claim });
        continue;
      }
      claimed = true;
      prepared = await delivery.prepareRoleSession({
        taskId: task.id,
        roleName: role.name,
        agentId: role.activeAgentId,
        adapterId: role.adapterId,
        workspace: role.workspace,
        mode,
        runId: run.id,
        ...(mode === "resume" ? { nativeSessionId: existingSession!.nativeSessionId } : {})
      });
      const ready = await delivery.waitUntilReady(prepared);
      const latestTask = store.getTask(task.id);
      if (latestTask === null || latestTask.status !== "active") {
        delivery.forgetPrepared?.({
          taskId: task.id,
          roleName: role.name,
          runId: run.id,
          ...(prepared.launchId === undefined
            ? {}
            : { launchId: prepared.launchId })
        });
        results.push({ taskId: task.id, status: "skipped", reason: "unavailable" });
        continue;
      }
      effectiveSession = validateReadySession(role.activeAgentId, existingSession, mode, ready.session);
      store.saveRoleRunPrepared({
        task,
        role,
        run,
        session: effectiveSession,
        ...(ready.prepared.launchId === undefined
          ? {}
          : { launchId: ready.prepared.launchId }),
        now
      });
      deliveryAttempted = true;
      const outcome = await delivery.sendOnce({
        delivery: ready,
        receiptId: `agent-run:${run.id}`,
        text: input
      });
      if (outcome === "busy" || outcome === "unavailable") {
        results.push({
          taskId: task.id,
          runId: run.id,
          status: "skipped",
          reason: "not-ready"
        });
        continue;
      }

      store.saveRoleRunDelivery({
        task,
        role,
        run,
        session: effectiveSession,
        ...(ready.prepared.launchId === undefined
          ? {}
          : { launchId: ready.prepared.launchId }),
        now
      });
      results.push({ taskId: task.id, runId: run.id, status: "dispatched" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = `Leader dispatch failed: ${detail}`;
      if (claimed && run !== null) {
        // Once delivery begins, a send may have succeeded even when receipt
        // observation or the aggregate write failed. Preserve the exact
        // durable Run and let receipt-backed active delivery recover it.
        if (deliveryAttempted) {
          results.push({
            taskId: task.id,
            runId: run.id,
            status: "failed",
            reason: "delivery-uncertain",
            error: message
          });
          continue;
        }
        delivery.forgetPrepared?.({
          taskId: task.id,
          roleName: role.name,
          runId: run.id,
          ...(prepared?.launchId === undefined
            ? {}
            : { launchId: prepared.launchId })
        });
        const failureResult = store.saveLeaderDispatchFailure({
          task,
          role,
          session: effectiveSession,
          claimed: { run, wakeup },
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
        if (failureResult === "state-changed") {
          results.push({ taskId: task.id, status: "skipped", reason: "state-changed" });
        } else {
          results.push({ taskId: task.id, runId: run.id, status: "failed", error: message });
        }
        continue;
      }
      results.push({
        taskId: task.id,
        runId: run?.id,
        status: "failed",
        reason: "not-ready",
        error: message
      });
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
  runId: string,
  reasons: readonly string[]
): string {
  const lines: string[] = [
    "Follow the injected yui-leader Skill for this Yui wakeup.",
    `Current Leader Run: ${runId}.`,
    `Yui wakeup reasons: ${reasons.join(", ")}.`,
    `Read the authoritative context with yui task context ${taskId}.`,
    `If the Task is Project-backed, read its catalog entry with yui project show <project> and inspect relevant Yui-maintained knowledge with yui project knowledge list <project> and yui project knowledge show <project> <knowledge>.`,
    "Use narrower Task message, WorkItem, decision, milestone, and input commands only when a specific record needs closer inspection.",
    `When the requested outcome is finished and there are no active Worker Runs or unresolved inputs, complete the Task with yui task complete ${taskId} --summary "<final outcome and evidence>".`,
    `Before ending this turn, if the Task was not completed and no InputRequest terminalized this Run, release the active fence with yui task run yield ${runId} --summary "<current result or waiting state>". In particular, yield before waiting for Worker results; do not return to an idle composer while this Run remains active.`
  ];
  return lines.join("\n");
}
