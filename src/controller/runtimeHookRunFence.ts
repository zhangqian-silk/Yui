import { openCompatibleFileTaskStore } from "../storage/compatibleTaskStore.js";
import {
  hasRuntimeCleanupObligation,
  isRuntimeLaunchReservation,
  runtimeLifecycleTarget
} from "../runtime/lifecycleReservation.js";
import { nativeSessionIdForLaunch } from "../runtime/preallocatedNativeSession.js";
import {
  runtimeObservationFromTaskEvent,
  type RuntimeObservation
} from "../runtime/runtimeObservation.js";
import {
  YUI_CONTROL_PLANE_DESCRIPTOR,
  YUI_TASK_RUNTIME_DESCRIPTOR,
  assertExactTaskRuntimeEnvironment,
  exactControlPlaneDigest,
  parseExactControlPlaneDescriptor,
  refreshReusedTaskRuntimeDescriptorSource
} from "../runtime/exactControlPlane.js";
import { agentRunDeliveryReceiptId } from "../run/agentRun.js";
import type { TaskEvent } from "../event/taskEvent.js";

export type RuntimeHookRunFence = Readonly<{
  taskId: string;
  roleName: string;
  agentId: string;
  launchId: string;
  runId: string;
  receiptId?: string;
  nativeSessionId: string;
  workspace: string;
}>;

export type RuntimeHookRunFenceOptions = Readonly<{
  startupSession?: "preallocated" | "discovered";
  /** Terminal Hooks may arrive after the exact Run has already yielded. */
  terminal?: boolean;
  /** Stable provider Turn identity used to recover its durable accepted Run. */
  nativeTurnId?: string;
  continuationId?: string;
  continuationGeneration?: number;
}>;

/**
 * Resolves turn identity from the current durable in-flight fence. The one
 * exception is a Driver-declared startup Session Hook, which can arrive before
 * Session projection and is fenced by the exact Run-bound launch reservation.
 * Preallocated identities are additionally checked against Yui's deterministic
 * launch identity. The immutable event is revalidated by the inbox fold.
 */
export function resolveRuntimeHookRunFence(
  environment: NodeJS.ProcessEnv,
  adapterId: string,
  payloadNativeSessionId: string,
  options: RuntimeHookRunFenceOptions = {}
): RuntimeHookRunFence {
  if (environment.YUI_SESSION_SCOPE !== "task") {
    throw new Error("Runtime observation Hook requires a Task session scope.");
  }
  if (environment.YUI_ADAPTER_ID !== adapterId) {
    throw new Error(`Runtime observation Hook requires the ${adapterId} adapter.`);
  }
  const home = requireIdentity(environment.YUI_HOME, "YUI_HOME");
  const taskId = requireIdentity(environment.YUI_TASK_ID, "Task id");
  const roleName = requireIdentity(environment.YUI_ROLE, "Role name");
  const agentId = requireIdentity(environment.YUI_AGENT_ID, "Agent id");
  const workspace = requireIdentity(environment.YUI_WORKSPACE, "YUI workspace");
  const runtimeSource = environment[YUI_TASK_RUNTIME_DESCRIPTOR];
  const runtime = runtimeSource === undefined
    ? undefined
    : assertExactTaskRuntimeEnvironment(
        runtimeSource,
        environment,
        exactControlPlaneDigest(parseExactControlPlaneDescriptor(requireIdentity(
          environment[YUI_CONTROL_PLANE_DESCRIPTOR],
          "Exact control-plane descriptor"
        ))),
        home
      );
  const launchId = requireIdentity(
    runtime?.launchId ?? environment.YUI_LAUNCH_ID,
    "Launch id"
  );
  const nativeSessionId = requireIdentity(payloadNativeSessionId, "Provider session id");
  const expectedNativeSessionId = runtime?.nativeSessionId ?? environment.YUI_NATIVE_SESSION_ID;
  if (expectedNativeSessionId !== undefined
    && nativeSessionId !== requireIdentity(expectedNativeSessionId, "YUI native session id")) {
    throw new Error("Runtime observation Hook native Session does not match its launch envelope.");
  }

  const store = openCompatibleFileTaskStore(home);
  const task = store.getTask(taskId);
  if (task === null
    || task.status !== "active"
    || task.executionGate.state !== "enabled") {
    throw new Error("Runtime observation Hook Task is not current and active.");
  }
  const role = store.getRole(taskId, roleName);
  if (role === null || role.activeAgentId !== agentId) {
    throw new Error("Runtime observation Hook Role or Agent is not current.");
  }
  const sessions = store.getTaskRoleSessionSet(taskId, roleName);
  if (sessions !== null && sessions.activeAgentId !== agentId) {
    throw new Error("Runtime observation Hook Session Agent is not current.");
  }
  const inFlight = sessions?.inFlight;
  const session = sessions?.sessions[agentId];
  const roleMailbox = store.getWorkMailbox({ kind: "role", taskId, roleName });
  const roleInputDelivery = roleMailbox?.inputDelivery;
  const roleExecution = roleMailbox?.processing?.executionRef;
  const activationReceiptId = roleInputDelivery?.executionRef?.type === "run"
    && roleInputDelivery.executionRef.taskId === taskId
    && roleInputDelivery.executionRef.id === inFlight?.runId
    ? roleInputDelivery.attemptId
    : roleExecution?.type === "run"
    && roleExecution.taskId === taskId
    && roleExecution.id === inFlight?.runId
    ? roleMailbox!.processing!.batchId
    : inFlight?.receiptId;
  const acceptedTurn = options.nativeTurnId === undefined
    ? null
    : acceptedTurnBinding(store.listEvents(taskId), {
        taskId,
        roleName,
        agentId,
        nativeSessionId,
        nativeTurnId: options.nativeTurnId
      });
  const acceptedBinding = acceptedTurn ?? (
    options.continuationId === undefined ? null : knownContinuationBinding(
      store.listEvents(taskId),
      {
        taskId,
        roleName,
        agentId,
        nativeSessionId,
        continuationId: options.continuationId,
        continuationGeneration: options.continuationGeneration ?? 1
      }
    )
  );
  const mailbox = store.getWorkMailbox(runtimeLifecycleTarget({
    scope: "task",
    taskId,
    roleName
  }));
  const exactReservation = isRuntimeLaunchReservation(mailbox?.processing, launchId)
    && !hasRuntimeCleanupObligation(mailbox);
  const executionRef = mailbox?.processing?.executionRef;
  const startupRunId = options.startupSession === undefined
    ? undefined
    : requireIdentity(
        runtime?.runId
          ?? environment.YUI_RUN_ID
          ?? (executionRef?.type === "run" && executionRef.taskId === taskId
            ? executionRef.id
            : undefined),
        "Run id"
      );
  const startupReservation = startupRunId !== undefined
    && exactReservation
    && executionRef?.type === "run"
    && executionRef.taskId === taskId
    && executionRef.id === startupRunId;
  const startupRun = startupRunId === undefined
    ? null
    : store.getAgentRun(taskId, startupRunId);
  const replacementStartup = options.startupSession !== undefined
    && session !== undefined
    && sessions !== null
    && startupReservation
    && startupRun?.mode === "new"
    && (session.status === "stopped" || session.status === "broken");
  const preallocatedStartup = options.startupSession === "preallocated"
    && expectedNativeSessionId !== undefined
    && (session === undefined || replacementStartup)
    && startupReservation
    && nativeSessionId === nativeSessionIdForLaunch(
      home,
      launchId,
      agentId,
      adapterId
    );
  const discoveredStartup = options.startupSession === "discovered"
    && expectedNativeSessionId === undefined
    && (session === undefined || replacementStartup)
    && startupReservation;
  const terminalRunId = options.terminal === true && acceptedBinding === null
    ? requireIdentity(environment.YUI_RUN_ID ?? runtime?.runId, "Run id")
    : undefined;
  const terminalRun = acceptedBinding !== null
    ? store.getAgentRun(taskId, acceptedBinding.fence.runId!)
    : terminalRunId === undefined
    ? null
    : store.getAgentRun(taskId, terminalRunId);
  const exactTerminal = terminalRun !== null
    && terminalRun.status !== "active"
    && terminalRun.roleName === roleName
    && terminalRun.effective.agentId === agentId
    && terminalRun.effective.adapterId === adapterId
    && session !== undefined
    && (acceptedBinding !== null || inFlight === null || inFlight === undefined);
  if ((inFlight === null || inFlight === undefined)
    && !preallocatedStartup
    && !discoveredStartup
    && !exactTerminal
    && acceptedBinding === null) {
    throw new Error("Runtime observation Hook has no matching durable in-flight Run.");
  }
  if (acceptedBinding === null
    && inFlight !== null && inFlight !== undefined && inFlight.agentId !== agentId) {
    throw new Error("Runtime observation Hook has no matching durable in-flight Run.");
  }
  if (
    (preallocatedStartup || discoveredStartup)
    && inFlight !== null
    && inFlight !== undefined
    && (
      inFlight.runId !== startupRunId
      || startupRun === null
      || inFlight.receiptId !== agentRunDeliveryReceiptId(startupRun)
    )
  ) {
    throw new Error("Runtime observation Hook has no matching durable in-flight Run.");
  }
  const runId = acceptedBinding?.fence.runId
    ?? inFlight?.runId
    ?? startupRunId
    ?? terminalRunId!;
  let effectiveRuntime = runtime;
  let effectiveLaunchId = acceptedBinding?.fence.launchId ?? launchId;
  const sessionLaunchId = session?.launchId;
  if (
    acceptedBinding === null
    && runtime !== undefined
    && session !== undefined
    && !replacementStartup
    && sessionLaunchId !== undefined
    && typeof runtimeSource === "string"
    && !runtimeSource.trimStart().startsWith("{")
    && (
      runtime.runId !== runId
      || runtime.launchId !== sessionLaunchId
      || runtime.nativeSessionId !== session.nativeSessionId
    )
  ) {
    // A reused native pane keeps its original descriptor source. Advance only
    // that Hook-owned source to the current durable generation before the
    // volatile fence; the Controller no longer scans history to keep it fresh.
    effectiveRuntime = refreshReusedTaskRuntimeDescriptorSource(
      runtimeSource,
      home,
      store,
      {
        runId,
        launchId: sessionLaunchId,
        nativeSessionId: session.nativeSessionId
      }
    );
    effectiveLaunchId = effectiveRuntime.launchId!;
  }
  if (acceptedBinding === null
    && effectiveRuntime?.runId !== undefined && effectiveRuntime.runId !== runId) {
    throw new Error("Runtime observation Hook Run does not match its current descriptor.");
  }
  const run = acceptedBinding !== null || exactTerminal
    ? terminalRun
    : store.getActiveAgentRun(taskId, roleName);
  if (run === null
    || run.id !== runId
    || (acceptedBinding === null && !exactTerminal && run.status !== "active")
    || run.effective.agentId !== agentId
    || run.effective.adapterId !== adapterId) {
    throw new Error("Runtime observation Hook Run does not match durable active state.");
  }
  if (run.effective.workspace.root !== workspace) {
    throw new Error("Runtime observation Hook workspace does not match the durable Run snapshot.");
  }
  if (session !== undefined && acceptedBinding === null && !replacementStartup) {
    if (session.adapterId !== adapterId
      || session.launchId !== effectiveLaunchId
      || session.nativeSessionId !== nativeSessionId
      || session.effective.workspace.root !== workspace) {
      throw new Error("Runtime observation Hook Session does not match its durable generation.");
    }
  } else if (acceptedBinding === null && (session === undefined || replacementStartup)) {
    if (!discoveredStartup && !preallocatedStartup) {
      throw new Error("Runtime observation Hook launch is not durably reserved.");
    }
  }
  return {
    taskId,
    roleName,
    agentId,
    launchId: effectiveLaunchId,
    runId,
    ...(acceptedBinding?.fence.receiptId === undefined
      ? activationReceiptId === undefined ? {} : { receiptId: activationReceiptId }
      : { receiptId: acceptedBinding.fence.receiptId }),
    nativeSessionId,
    workspace
  };
}

function knownContinuationBinding(
  events: readonly TaskEvent[],
  expected: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    nativeSessionId: string;
    continuationId: string;
    continuationGeneration: number;
  }>
): RuntimeObservation | null {
  const matches = events
    .map(runtimeObservationFromTaskEvent)
    .filter((observation): observation is RuntimeObservation => observation !== null
      && observation.kind.startsWith("continuation.")
      && observation.fence.taskId === expected.taskId
      && observation.fence.roleName === expected.roleName
      && observation.fence.agentId === expected.agentId
      && observation.fence.nativeSessionId === expected.nativeSessionId
      && observation.fence.continuationId === expected.continuationId
      && observation.fence.continuationGeneration === expected.continuationGeneration
      && observation.fence.runId !== undefined)
    .sort((left, right) => (
      left.receivedAt.localeCompare(right.receivedAt)
      || (left.sequence ?? -1) - (right.sequence ?? -1)
      || (left.ordinal ?? -1) - (right.ordinal ?? -1)
      || left.eventId.localeCompare(right.eventId)
    ));
  const binding = matches.at(-1) ?? null;
  if (binding === null) return null;
  if (matches.some((candidate) => candidate.fence.runId !== binding.fence.runId
    || candidate.fence.launchId !== binding.fence.launchId
    || candidate.fence.receiptId !== binding.fence.receiptId)) {
    throw new Error("Runtime observation Hook continuation has conflicting durable Run bindings.");
  }
  return binding;
}

function acceptedTurnBinding(
  events: readonly TaskEvent[],
  expected: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    nativeSessionId: string;
    nativeTurnId: string;
  }>
): RuntimeObservation | null {
  const matches = events
    .map(runtimeObservationFromTaskEvent)
    .filter((observation): observation is RuntimeObservation => observation !== null
      && observation.kind === "turn.accepted"
      && observation.fence.taskId === expected.taskId
      && observation.fence.roleName === expected.roleName
      && observation.fence.agentId === expected.agentId
      && observation.fence.nativeSessionId === expected.nativeSessionId
      && observation.fence.nativeTurnId === expected.nativeTurnId
      && observation.fence.runId !== undefined)
    .sort((left, right) => (
      left.receivedAt.localeCompare(right.receivedAt)
      || (left.sequence ?? -1) - (right.sequence ?? -1)
      || (left.ordinal ?? -1) - (right.ordinal ?? -1)
      || left.eventId.localeCompare(right.eventId)
    ));
  const binding = matches.at(-1) ?? null;
  if (binding === null) return null;
  if (matches.some((candidate) => candidate.fence.runId !== binding.fence.runId
    || candidate.fence.launchId !== binding.fence.launchId
    || candidate.fence.receiptId !== binding.fence.receiptId)) {
    throw new Error("Runtime observation Hook native Turn has conflicting durable Run bindings.");
  }
  return binding;
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
