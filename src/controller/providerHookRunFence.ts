import type { AgentAdapterId } from "../agent/adapterCatalog.js";
import { openCompatibleFileTaskStore } from "../storage/compatibleTaskStore.js";
import {
  hasRuntimeCleanupObligation,
  isRuntimeLaunchReservation,
  runtimeLifecycleTarget
} from "../runtime/lifecycleReservation.js";
import { nativeSessionIdForLaunch } from "../runtime/preallocatedNativeSession.js";
import { formatAgentRunReceiptId } from "../task/taskRecordReference.js";

export type ProviderHookRunFence = Readonly<{
  taskId: string;
  roleName: string;
  agentId: string;
  launchId: string;
  runId: string;
  receiptId?: string;
  nativeSessionId: string;
  workspace: string;
}>;

export type ProviderHookRunFenceOptions = Readonly<{
  allowPreallocatedClaudeStartup?: boolean;
}>;

/**
 * Resolves turn identity from the current durable in-flight fence. The one
 * exception is Claude SessionStart(startup), which can arrive synchronously
 * before Session projection and is fenced by the exact Run-bound launch
 * reservation plus deterministic native identity. The immutable hook event is
 * revalidated by the normal inbox fold before changing any state.
 */
export function resolveProviderHookRunFence(
  environment: NodeJS.ProcessEnv,
  adapterId: AgentAdapterId,
  payloadNativeSessionId: string,
  options: ProviderHookRunFenceOptions = {}
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

  const store = openCompatibleFileTaskStore(home);
  const task = store.getTask(taskId);
  if (task === null || task.status !== "active") {
    throw new Error("Provider lifecycle hook Task is not current and active.");
  }
  const role = store.getRole(taskId, roleName);
  if (role === null || role.activeAgentId !== agentId) {
    throw new Error("Provider lifecycle hook Role or Agent is not current.");
  }
  const sessions = store.getTaskRoleSessionSet(taskId, roleName);
  if (sessions !== null && sessions.activeAgentId !== agentId) {
    throw new Error("Provider lifecycle hook Session Agent is not current.");
  }
  const inFlight = sessions?.inFlight;
  const session = sessions?.sessions[agentId];
  const mailbox = store.getWorkMailbox(runtimeLifecycleTarget({
    scope: "task",
    taskId,
    roleName
  }));
  const exactReservation = isRuntimeLaunchReservation(mailbox?.processing, launchId)
    && !hasRuntimeCleanupObligation(mailbox);
  const executionRef = mailbox?.processing?.executionRef;
  const startupRunId = options.allowPreallocatedClaudeStartup === true
    ? requireIdentity(environment.YUI_RUN_ID, "Run id")
    : undefined;
  const deterministicClaudeStartup = adapterId === "claude"
    && options.allowPreallocatedClaudeStartup === true
    && expectedNativeSessionId !== undefined
    && session === undefined
    && exactReservation
    && executionRef?.type === "run"
    && executionRef.taskId === taskId
    && executionRef.id === startupRunId
    && nativeSessionId === nativeSessionIdForLaunch(
      home,
      launchId,
      agentId,
      adapterId
    );
  if ((inFlight === null || inFlight === undefined) && !deterministicClaudeStartup) {
    throw new Error("Provider lifecycle hook has no matching durable in-flight Run.");
  }
  if (inFlight !== null && inFlight !== undefined && inFlight.agentId !== agentId) {
    throw new Error("Provider lifecycle hook has no matching durable in-flight Run.");
  }
  if (
    deterministicClaudeStartup
    && inFlight !== null
    && inFlight !== undefined
    && (
      inFlight.runId !== startupRunId
      || inFlight.receiptId !== formatAgentRunReceiptId(taskId, startupRunId!)
    )
  ) {
    throw new Error("Provider lifecycle hook has no matching durable in-flight Run.");
  }
  const runId = inFlight?.runId ?? startupRunId!;
  const run = store.getActiveAgentRun(taskId, roleName);
  if (run === null
    || run.id !== runId
    || run.status !== "active"
    || run.effective.agentId !== agentId
    || run.effective.adapterId !== adapterId) {
    throw new Error("Provider lifecycle hook Run does not match durable active state.");
  }
  if (run.effective.workspace.root !== workspace) {
    throw new Error("Provider lifecycle hook workspace does not match the durable Run snapshot.");
  }
  if (session !== undefined) {
    if (session.adapterId !== adapterId
      || session.launchId !== launchId
      || session.nativeSessionId !== nativeSessionId
      || session.effective.workspace.root !== workspace) {
      throw new Error("Provider lifecycle hook Session does not match its durable generation.");
    }
  } else {
    const runtimeDiscoveredCodex = adapterId === "codex"
      && expectedNativeSessionId === undefined
      && exactReservation;
    if (!runtimeDiscoveredCodex && !deterministicClaudeStartup) {
      throw new Error("Provider lifecycle hook launch is not durably reserved.");
    }
  }
  return {
    taskId,
    roleName,
    agentId,
    launchId,
    runId,
    ...(inFlight?.receiptId === undefined ? {} : { receiptId: inFlight.receiptId }),
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
