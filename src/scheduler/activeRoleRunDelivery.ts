import type {
  PreparedRoleDelivery,
  ReadyRoleDelivery,
  SchedulerAgentRun,
  RoleRunDeliveryFailurePersistence,
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
import { formatAgentRunReceiptId } from "../task/taskRecordReference.js";
import { effectiveLaunchSnapshotsCompatible } from "../executor/effectiveLaunch.js";
import { RuntimeLaunchError } from "../runtime/ports.js";
import {
  isPreInputReadinessSupported
} from "../lifecycle/canonicalLifecycleEvent.js";
import { preInputReadinessCapability } from "../lifecycle/providerLifecycleMapping.js";

export type ActiveRoleRunDeliveryResult = Readonly<{
  taskId: string;
  roleName: string;
  runId: string;
  status: "delivered" | "already-delivered" | "skipped" | "failed";
  reason?: "workspace-not-ready" | "launch-failed" | "generation-lost" | "mailbox-empty" | "mailbox-busy" | "not-ready" | "runtime-unavailable" | "delivery-uncertain";
  error?: string;
  terminalFailure?: Omit<RoleRunDeliveryFailurePersistence, "now">;
  terminalized?: boolean;
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
      // is recoverable through the same receipt-backed delivery path. The
      // re-push guard keys on pushedAt (transport), not deliveredAt (provider
      // acceptance): a pushed-but-unaccepted Run must never be pushed twice —
      // no duplicate Enter while acceptance is still pending.
      if (run === null || run.pushedAt !== undefined) continue;
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

      const existingSession = store.getRoleSession(
        task.id,
        role.name,
        run.effective.agentId
      );
      const receiptId = formatAgentRunReceiptId(task.id, run.id);
      const target = { kind: "role", taskId: task.id, roleName: role.name } as const;
      const claim = store.claimWorkMailbox({
        target,
        batchId: receiptId,
        owner: "controller",
        now,
        executionRef: { type: "run", taskId: task.id, id: run.id }
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
      if (
        processing.executionRef?.type !== "run"
        || processing.executionRef.taskId !== task.id
        || processing.executionRef.id !== run.id
      ) {
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
      let preparedSession: SchedulerRoleSession | null = existingSession;
      let deliveryAttempted = false;
      try {
        const nativeSessionId = run.mode === "resume"
          ? requireResumeSession(role, run.effective, existingSession)
          : undefined;
        prepared = await delivery.prepareRoleSession({
          taskId: task.id,
          roleName: role.name,
          agentId: run.effective.agentId,
          adapterId: run.effective.adapterId,
          effective: run.effective,
          workspace: run.effective.workspace.root,
          ...(run.workspace === undefined
            ? {}
            : { managedWorkspace: run.workspace }),
          mode: run.mode,
          runId: run.id,
          ...(nativeSessionId === undefined ? {} : { nativeSessionId })
        });
        const ready = await delivery.waitUntilReady(prepared);
        const session = validateReadySession(
          role,
          run.effective,
          existingSession,
          run.mode,
          ready
        );
        preparedSession = session;
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
        // Pre-input readiness gate. For an adapter whose capability proves a
        // native event fires before the first prompt (e.g. Claude SessionStart),
        // a freshly-started host must not be pushed until that provider-ready
        // fact has been folded. Unsupported adapters (e.g. Codex) have no
        // pre-input event, so their push proceeds and acceptance is confirmed
        // only by the later exact provider-accepted fold. The gate reads the
        // adapter capability and the durable ready projection — never a sleep,
        // screen scrape, or pane/PID inference — and fails closed for a
        // supported adapter whose readiness cannot be confirmed.
        if (
          ready.prepared.sessionStarted
          && isPreInputReadinessSupported(preInputReadinessCapability(run.effective.adapterId))
          && !providerReadyForPush(store, {
            taskId: task.id,
            roleName: role.name,
            agentId: run.effective.agentId,
            ...(ready.prepared.launchId === undefined ? {} : { launchId: ready.prepared.launchId }),
            ...(session?.nativeSessionId === undefined
              ? {}
              : { nativeSessionId: session.nativeSessionId })
          })
        ) {
          results.push({
            taskId: task.id,
            roleName: role.name,
            runId: run.id,
            status: "skipped",
            reason: "not-ready"
          });
          continue;
        }
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
            reason: outcome === "busy" ? "not-ready" : "runtime-unavailable",
            terminalFailure: roleRunDeliveryFailure(
              run,
              processing.batchId,
              session,
              ready.prepared.launchId
            )
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
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof RuntimeLaunchError) {
          const terminalFailure = roleRunDeliveryFailure(
            run,
            processing.batchId,
            existingSession,
            error.launchId
          );
          if (error.retryable) {
            results.push({
              taskId: task.id,
              roleName: role.name,
              runId: run.id,
              status: "skipped",
              reason: "runtime-unavailable",
              error: message,
              terminalFailure
            });
            continue;
          }
          const persisted = store.saveRoleRunDeliveryFailure({
            ...terminalFailure,
            now
          });
          if (persisted === "failed") {
            delivery.forgetPrepared?.({
              taskId: task.id,
              roleName: role.name,
              runId: run.id,
              launchId: error.launchId
            });
          }
          results.push({
            taskId: task.id,
            roleName: role.name,
            runId: run.id,
            status: "failed",
            reason: "generation-lost",
            error: persisted === "state-changed"
              ? "Run state changed during exact launch generation failure."
              : message,
            terminalized: persisted === "failed"
          });
          continue;
        }
        if (!deliveryAttempted) {
          delivery.forgetPrepared?.({
            taskId: task.id,
            roleName: role.name,
            runId: run.id,
            ...(prepared?.launchId === undefined
              ? {}
              : { launchId: prepared.launchId })
          });
          const persisted = store.saveExitedRoleRun({
            task,
            role,
            run,
            session: existingSession,
            summary: `Role Run could not start: ${message}`,
            now
          });
          results.push({
            taskId: task.id,
            roleName: role.name,
            runId: run.id,
            status: "failed",
            reason: "launch-failed",
            error: persisted === "state-changed" ? "Run state changed during launch failure." : message
          });
          continue;
        }
        results.push({
          taskId: task.id,
          roleName: role.name,
          runId: run.id,
          status: "failed",
          reason: "delivery-uncertain",
          error: message,
          terminalFailure: roleRunDeliveryFailure(
            run,
            processing.batchId,
            preparedSession,
            prepared?.launchId
          )
        });
      }
    }
  }
  return results;
}

function roleRunDeliveryFailure(
  run: SchedulerAgentRun,
  mailboxBatchId: string,
  session: SchedulerRoleSession | null,
  launchId: string | undefined
): Omit<RoleRunDeliveryFailurePersistence, "now"> {
  return {
    taskId: run.taskId,
    roleName: run.roleName,
    agentId: run.effective.agentId,
    adapterId: run.effective.adapterId,
    runId: run.id,
    mailboxBatchId,
    ...(session?.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: session.nativeSessionId }),
    ...(launchId === undefined ? {} : { launchId })
  };
}

function requireResumeSession(
  role: SchedulerRole,
  effective: import("../executor/effectiveLaunch.js").EffectiveLaunchSnapshot,
  session: SchedulerRoleSession | null
): string {
  if (session === null || !hasText(session.nativeSessionId)) {
    throw new Error(`Role resume has no fixed native session: ${role.taskId}/${role.name}.`);
  }
  if (!effectiveLaunchSnapshotsCompatible(session.effective, effective)) {
    throw new Error(`Role resume effective snapshot drifted: ${role.taskId}/${role.name}.`);
  }
  return session.nativeSessionId;
}

function validateReadySession(
  role: SchedulerRole,
  effective: import("../executor/effectiveLaunch.js").EffectiveLaunchSnapshot,
  existing: SchedulerRoleSession | null,
  mode: "new" | "resume",
  ready: ReadyRoleDelivery
): SchedulerRoleSession | null {
  const session = ready.session;
  if (mode === "new" && session === null) return null;
  if (session === null || !hasText(session.nativeSessionId)) {
    throw new Error(`Ready Role session has no native session id: ${role.taskId}/${role.name}.`);
  }
  if (session.agentId !== effective.agentId || session.adapterId !== effective.adapterId) {
    throw new Error(`Ready Role session identity changed: ${role.taskId}/${role.name}.`);
  }
  if (!effectiveLaunchSnapshotsCompatible(session.effective, effective)) {
    throw new Error(`Ready Role session effective snapshot changed: ${role.taskId}/${role.name}.`);
  }
  if (existing?.nativeSessionId !== undefined
    && effectiveLaunchSnapshotsCompatible(existing.effective, effective)
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

/**
 * Fail-closed readiness check for a supported-readiness adapter's first push.
 * When the store cannot answer (no implementation), the push is held rather than
 * proceeding blind — a supported adapter must have a proven provider-ready fold.
 */
function providerReadyForPush(
  store: SchedulerStorePort,
  input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    launchId?: string;
    nativeSessionId?: string;
  }>
): boolean {
  if (store.isRoleGenerationProviderReady === undefined) return false;
  return store.isRoleGenerationProviderReady(input);
}
