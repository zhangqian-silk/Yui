import type { AgentAdapterId } from "../agent/adapterCatalog.js";
import { FileTaskStore } from "../storage/taskStore.js";
import {
  isRuntimeLaunchReservation,
  runtimeLifecycleTarget
} from "../runtime/lifecycleReservation.js";

export type ProviderHookRunFence = Readonly<{
  taskId: string;
  roleName: string;
  agentId: string;
  launchId: string;
  runId: string;
  receiptId: string;
  nativeSessionId: string;
  workspace: string;
}>;

/**
 * Resolves turn identity from the current durable in-flight fence. Provider
 * processes are long-lived, so their launch environment cannot identify later
 * Runs. The immutable hook event freezes the current Run/receipt here; the
 * normal inbox fold revalidates it before changing any state.
 */
export function resolveProviderHookRunFence(
  environment: NodeJS.ProcessEnv,
  adapterId: AgentAdapterId,
  payloadNativeSessionId: string
): ProviderHookRunFence {
  if (environment.YUI_SESSION_SCOPE !== "task") {
    throw new Error("Provider lifecycle hook requires a Task session scope.");
  }
  if (environment.YUI_ADAPTER_ID !== adapterId) {
    throw new Error(`Provider lifecycle hook requires the ${adapterId} adapter.`);
  }
  const home = requireIdentity(environment.YUI_HOME, "YUI_HOME");
  const taskId = requireIdentity(environment.YUI_TASK_ID, "Task id");
  const roleName = requireIdentity(environment.YUI_ROLE, "Role name");
  const agentId = requireIdentity(environment.YUI_AGENT_ID, "Agent id");
  const workspace = requireIdentity(environment.YUI_WORKSPACE, "YUI workspace");
  const launchId = requireIdentity(environment.YUI_LAUNCH_ID, "Launch id");
  const nativeSessionId = requireIdentity(payloadNativeSessionId, "Provider session id");
  const expectedNativeSessionId = environment.YUI_NATIVE_SESSION_ID;
  if (expectedNativeSessionId !== undefined
    && nativeSessionId !== requireIdentity(expectedNativeSessionId, "YUI native session id")) {
    throw new Error("Provider lifecycle hook native session does not match its launch envelope.");
  }

  const store = new FileTaskStore(home);
  const sessions = store.getTaskRoleSessionSet(taskId, roleName);
  if (sessions === null || sessions.inFlight === null) {
    throw new Error("Provider lifecycle hook has no matching durable in-flight Run.");
  }
  const inFlight = sessions.inFlight;
  if (inFlight.agentId !== agentId) {
    throw new Error("Provider lifecycle hook has no matching durable in-flight Run.");
  }
  const run = store.getActiveAgentRun(taskId, roleName);
  if (run === null
    || run.id !== inFlight.runId
    || run.status !== "active"
    || run.effective.agentId !== agentId
    || run.effective.adapterId !== adapterId) {
    throw new Error("Provider lifecycle hook Run does not match durable active state.");
  }
  if (run.effective.workspace.root !== workspace) {
    throw new Error("Provider lifecycle hook workspace does not match the durable Run snapshot.");
  }
  const session = sessions.sessions[agentId];
  if (session !== undefined) {
    if (session.adapterId !== adapterId
      || session.launchId !== launchId
      || session.nativeSessionId !== nativeSessionId
      || session.effective.workspace.root !== workspace) {
      throw new Error("Provider lifecycle hook Session does not match its durable generation.");
    }
  } else if (adapterId !== "codex" || expectedNativeSessionId !== undefined) {
    // Only a runtime-discovered Codex session may report its native id before
    // the RoleSessionSet contains that session. Preallocated providers must
    // already match their durable Session record.
    throw new Error("Provider lifecycle hook Session is not durably reserved.");
  } else {
    const mailbox = store.getWorkMailbox(runtimeLifecycleTarget({
      scope: "task",
      taskId,
      roleName
    }));
    if (!isRuntimeLaunchReservation(mailbox?.processing, launchId)) {
      throw new Error("Provider lifecycle hook launch is not durably reserved.");
    }
  }
  return {
    taskId,
    roleName,
    agentId,
    launchId,
    runId: inFlight.runId,
    receiptId: inFlight.receiptId,
    nativeSessionId,
    workspace
  };
}

function requireIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`${label} is required.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 1_024) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}
