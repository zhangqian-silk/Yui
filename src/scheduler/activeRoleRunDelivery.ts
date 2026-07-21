import type {
  ReadyRoleDelivery,
  SchedulerRole,
  SchedulerRoleSession,
  SchedulerStorePort,
  TmuxDeliveryPort
} from "./ports.js";

export type ActiveRoleRunDeliveryResult = Readonly<{
  taskId: string;
  roleName: string;
  runId: string;
  status: "delivered" | "already-delivered" | "skipped" | "failed";
  reason?: "workspace-not-ready";
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
  now: Date
): Promise<ActiveRoleRunDeliveryResult[]> {
  const results: ActiveRoleRunDeliveryResult[] = [];
  for (const task of store.listTasks()) {
    if (task.status !== "active") continue;
    for (const role of store.listRoles(task.id)) {
      const run = store.getActiveAgentRun(task.id, role.name);
      // A crash after a Leader wake is durably claimed but before tmux input
      // is recoverable through the same receipt-backed delivery path.
      if (run === null || run.deliveredAt !== undefined) continue;
      if (task.repositoryId !== undefined && task.cwd === undefined) {
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
      try {
        const nativeSessionId = run.mode === "resume"
          ? requireResumeSession(role, existingSession)
          : undefined;
        const prepared = await delivery.prepareRoleSession({
          taskId: task.id,
          roleName: role.name,
          agentId: role.activeAgentId,
          adapterId: role.adapterId,
          mode: run.mode,
          ...(nativeSessionId === undefined ? {} : { nativeSessionId })
        });
        const existingReceipt = await delivery.findExistingReceipt?.({
          delivery: prepared,
          receiptId
        }) ?? null;
        const ready = existingReceipt ?? await delivery.waitUntilReady(prepared);
        const session = validateReadySession(role, existingSession, run.mode, ready);
        let status: ActiveRoleRunDeliveryResult["status"] = "already-delivered";
        if (existingReceipt === null) {
          status = await delivery.sendOnce({
            delivery: ready,
            receiptId,
            text: run.input
          }) === "sent" ? "delivered" : "already-delivered";
        }
        store.saveRoleRunDelivery({ task, role, run, session, now });
        results.push({ taskId: task.id, roleName: role.name, runId: run.id, status });
      } catch (error) {
        results.push({
          taskId: task.id,
          roleName: role.name,
          runId: run.id,
          status: "failed",
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
  if (mode === "resume" && session.nativeSessionId !== existing?.nativeSessionId) {
    throw new Error(`Role resume changed the fixed native session id: ${role.taskId}/${role.name}.`);
  }
  return { ...session, status: "running" };
}

function hasText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
