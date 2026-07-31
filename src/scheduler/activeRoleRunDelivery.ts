import type {
  PreparedRoleDelivery,
  ReadyRoleDelivery,
  SchedulerRole,
  SchedulerRoleSession,
  SchedulerStorePort,
  TmuxDeliveryPort
} from "./ports.js";
import {
  selectedSchedulerRoles,
  selectedSchedulerTasks,
  type SchedulerReconcileSelection
} from "./ports.js";

export type ActiveRoleRunDeliveryResult = Readonly<{
  taskId: string;
  roleName: string;
  runId: string;
  status: "delivered" | "already-delivered" | "skipped" | "failed";
  reason?: "workspace-not-ready" | "mailbox-empty" | "mailbox-busy" | "not-ready" | "runtime-unavailable" | "delivery-uncertain";
  error?: string;
}>;

/**
 * Delivers durable Work AgentRuns before liveness reconciliation. Task command
 * handlers only record intent; this Controller path is the sole automated
 * route into the Agent terminal, through tmux receipt-backed delivery.
 */
export async function processActiveRoleRunDeliveries(
  store: SchedulerStorePort,
  delivery: TmuxDeliveryPort,
  now: Date,
  selection?: SchedulerReconcileSelection
): Promise<ActiveRoleRunDeliveryResult[]> {
  const results: ActiveRoleRunDeliveryResult[] = [];
  for (const task of selectedSchedulerTasks(store, selection)) {
    if (task.status !== "active") continue;
    for (const role of selectedSchedulerRoles(store, task.id, selection)) {
      const run = store.getActiveAgentRun(task.id, role.name);
      // A crash after a Leader wake is durably claimed but before tmux input
      // is recoverable through the same receipt-backed delivery path.
      if (run === null || run.deliveredAt !== undefined) continue;
      if (task.projectBindings.length > 0 && task.cwd === undefined) {
        results.push({
          taskId: task.id,
          roleName: role.name,
          runId: run.id,
          status: "skipped",
          reason: "workspace-not-ready"
        });
        continue;
      }

      const existingSession = store.getRoleSession(task.id, role.name);
      const receiptId = `agent-run:${run.id}`;
      const target = { kind: "role", taskId: task.id, roleName: role.name } as const;
      const claim = store.claimWorkMailbox({
        target,
        batchId: receiptId,
        owner: "controller",
        now,
        executionRef: { type: "run", id: run.id }
      });
      if (claim.status === "empty") {
        results.push({
          taskId: task.id,
          roleName: role.name,
          runId: run.id,
          status: "skipped",
          reason: "mailbox-empty"
        });
        continue;
      }
      const processing = claim.processing;
      if (processing.executionRef?.type !== "run" || processing.executionRef.id !== run.id) {
        results.push({
          taskId: task.id,
          roleName: role.name,
          runId: run.id,
          status: "skipped",
          reason: "mailbox-busy"
        });
        continue;
      }
      let prepared: PreparedRoleDelivery | undefined;
      let deliveryAttempted = false;
      try {
        const nativeSessionId = run.mode === "resume"
          ? requireResumeSession(role, existingSession)
          : undefined;
        prepared = await delivery.prepareRoleSession({
          taskId: task.id,
          roleName: role.name,
          agentId: role.activeAgentId,
          adapterId: role.adapterId,
          workspace: role.workspace,
          mode: run.mode,
          runId: run.id,
          ...(nativeSessionId === undefined ? {} : { nativeSessionId })
        });
        const ready = await delivery.waitUntilReady(prepared);
        const session = validateReadySession(role, existingSession, run.mode, ready);
        store.saveRoleRunPrepared({
          task,
          role,
          run,
          session,
          ...(ready.prepared.launchId === undefined
            ? {}
            : { launchId: ready.prepared.launchId }),
          now
        });
        deliveryAttempted = true;
        const outcome = await delivery.sendOnce({
          delivery: ready,
          receiptId,
          text: run.input
        });
        if (outcome === "busy" || outcome === "unavailable") {
          results.push({
            taskId: task.id,
            roleName: role.name,
            runId: run.id,
            status: "skipped",
            reason: outcome === "busy" ? "not-ready" : "runtime-unavailable"
          });
          continue;
        }
        const status = outcome === "sent" ? "delivered" : "already-delivered";
        store.saveRoleRunDelivery({
          task,
          role,
          run,
          session,
          ...(ready.prepared.launchId === undefined
            ? {}
            : { launchId: ready.prepared.launchId }),
          now
        });
        results.push({ taskId: task.id, roleName: role.name, runId: run.id, status });
      } catch (error) {
        if (!deliveryAttempted) {
          delivery.forgetPrepared?.({
            taskId: task.id,
            roleName: role.name,
            runId: run.id,
            ...(prepared?.launchId === undefined
              ? {}
              : { launchId: prepared.launchId })
          });
        }
        store.releaseWorkMailbox(target, processing.batchId);
        results.push({
          taskId: task.id,
          roleName: role.name,
          runId: run.id,
          status: "failed",
          reason: "delivery-uncertain",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
  return results;
}

function requireResumeSession(
  role: SchedulerRole,
  session: SchedulerRoleSession | null
): string {
  if (session === null || !hasText(session.nativeSessionId)) {
    throw new Error(`Role resume has no fixed native session: ${role.taskId}/${role.name}.`);
  }
  return session.nativeSessionId;
}

function validateReadySession(
  role: SchedulerRole,
  existing: SchedulerRoleSession | null,
  mode: "new" | "resume",
  ready: ReadyRoleDelivery
): SchedulerRoleSession | null {
  const session = ready.session;
  if (mode === "new" && session === null) return null;
  if (session === null || !hasText(session.nativeSessionId)) {
    throw new Error(`Ready Role session has no native session id: ${role.taskId}/${role.name}.`);
  }
  if (session.agentId !== role.activeAgentId || session.adapterId !== role.adapterId) {
    throw new Error(`Ready Role session identity changed: ${role.taskId}/${role.name}.`);
  }
  if (existing?.nativeSessionId !== undefined
    && session.nativeSessionId !== existing.nativeSessionId) {
    throw new Error(`Ready Role session changed the fixed native session id: ${role.taskId}/${role.name}.`);
  }
  if (mode === "resume" && session.nativeSessionId !== existing?.nativeSessionId) {
    throw new Error(`Role resume changed the fixed native session id: ${role.taskId}/${role.name}.`);
  }
  return { ...session, status: "running" };
}

function hasText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
