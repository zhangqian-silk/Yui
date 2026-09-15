import { randomUUID } from "node:crypto";
import { serializeRunInputEnvelope } from "../context/runInputContract.js";
import {
  roleSessionMayContinue,
  sameEffectiveLaunch
} from "../executor/effectiveLaunch.js";
import { RuntimeLifecycleBusyError } from "../runtime/lifecycleReservation.js";
import { managedProviderTurnId } from "../runtime/providerRuntimeIdentity.js";
import {
  formatProviderDeliveryFailure,
  providerDeliveryFailureFacts,
  innermostCauseName,
  serializeAgentErrorRaw
} from "../runtime/agentError.js";
import { RuntimeLaunchFailure } from "../runtime/launchDiagnostics.js";
import {
  RuntimeLaunchError,
  type RuntimeLaunchPreflight
} from "../runtime/ports.js";
import { formatRunReceiptId } from "../task/taskRecordReference.js";
import { taskOwnsManagedWorkspace } from "../task/task.js";
import { runInputEnvelope } from "../agentRun/agentRun.js";
import {
  captureRoleRunDispatch,
  type RoleRunDispatchToken
} from "../coordination/workMailboxQueue.js";
import type {
  PreparedRoleDelivery,
  SchedulerRun,
  SchedulerRole,
  SchedulerRoleSession,
  SchedulerStorePort,
  SchedulerTask,
  TmuxDeliveryPort
} from "./ports.js";
import {
  isSchedulerPlanningDraft,
  isSchedulerTaskWorkspaceReady,
  selectedActiveSchedulerTasks,
  selectedSchedulerRoles,
  type SchedulerReconcileSelection
} from "./ports.js";

export type ActiveRoleRunDeliveryResult = Readonly<{
  taskId: string;
  roleName: string;
  runId: string;
  status: "delivered" | "already-delivered" | "skipped" | "failed";
  reason?: "workspace-not-ready" | "launch-failed" | "provider-rejected" | "mailbox-empty" | "mailbox-busy" | "not-ready" | "runtime-unavailable" | "writer-attached" | "delivery-uncertain";
  error?: string;
  terminalized?: boolean;
}>;

/**
 * Sole managed Provider write path. A AgentRun is durable workflow intent;
 * each invocation here is an ordinary Provider-native Turn on the Role's
 * shared conversation. Stable request ids make a repeated submit idempotent
 * without copying Provider delivery state into AgentRun or WorkMailbox.
 */
export async function processActiveRoleRunDeliveries(
  store: SchedulerStorePort,
  delivery: TmuxDeliveryPort,
  now: Date,
  selection?: SchedulerReconcileSelection
): Promise<ActiveRoleRunDeliveryResult[]> {
  const results: ActiveRoleRunDeliveryResult[] = [];
  // Planning Turns are admitted on a Draft, so delivery must be able to see
  // that Draft or an admitted planning Turn would never be delivered, resumed
  // or terminalized. Selection still admits it only on its durable Turn.
  for (const task of selectedActiveSchedulerTasks(store, selection, {
    includePlanningDrafts: true
  })) {
    store.prepareMessageContinuations(task.id, now);
    for (const role of selectedSchedulerRoles(store, task.id, selection)) {
      const run = store.getActiveRun(task.id, role.name);
      if (run === null) continue;
      results.push(await deliverActiveRun(store, delivery, task, role, run, now));
    }
  }
  return results;
}

async function deliverActiveRun(
  store: SchedulerStorePort,
  delivery: TmuxDeliveryPort,
  task: SchedulerTask,
  role: SchedulerRole,
  run: SchedulerRun,
  now: Date
): Promise<ActiveRoleRunDeliveryResult> {
  const base = { taskId: task.id, roleName: role.name, runId: run.id };
  if (!isSchedulerTaskWorkspaceReady(
    task,
    store.getTaskWorkspace(task.id),
    run.purpose
  )) {
    return { ...base, status: "skipped", reason: "workspace-not-ready" };
  }

  const dispatchToken = captureRoleRunDispatch(store.getWorkMailbox({
    kind: "role",
    taskId: task.id,
    roleName: role.name
  }), {
    taskId: task.id,
    roleName: role.name,
    runId: run.id
  });
  const sessionSet = store.getTaskRoleSessionSet(task.id, role.name);
  const binding = sessionSet?.providerBinding ?? null;
  if (binding?.retry !== undefined && (binding.retry.successorRunId === run.id
      || binding.retry.successorReviewRoundId !== undefined && binding.retry.successorReviewRoundId === run.reviewRoundId)
    && ["cancelled", "exhausted", "needs-attention"].includes(binding.retry.status)
    && binding.run?.runId !== run.id) {
    return failRunDelivery(store, run, now, "runtime-failed",
      `Scheduled Provider retry ${binding.retry.status}: ${binding.retry.reason ?? "not admitted"}`);
  }
  if (binding?.retry?.status === "waiting"
    && (binding.retry.successorRunId === run.id || binding.retry.successorReviewRoundId !== undefined
      && binding.retry.successorReviewRoundId === run.reviewRoundId)
    && now.getTime() < Date.parse(binding.retry.nextEligibleAt)) {
    return { ...base, status: "skipped", reason: "not-ready" };
  }
  const observedRun = binding?.run ?? null;
  const initialAttemptId = formatRunReceiptId(task.id, run.id);
  const currentProviderTurn = managedProviderTurnId(observedRun) === run.id ? observedRun : null;

  if (binding?.authority.owner === "human"
    || binding?.authority.owner === "unknown") {
    return { ...base, status: "skipped", reason: "writer-attached" };
  }
  if (currentProviderTurn === null && observedRun !== null
    && ["submitting", "accepted", "delivery-unknown"].includes(observedRun.status)) {
    return { ...base, status: "skipped",
      reason: observedRun.status === "delivery-unknown" ? "delivery-uncertain" : "not-ready" };
  }
  if (currentProviderTurn?.status === "accepted") {
    settleAcceptedRoleRunDispatch(store, run, dispatchToken);
    return { ...base, status: "skipped", reason: "not-ready" };
  }
  if (currentProviderTurn?.status === "submitting") {
    return { ...base, status: "skipped", reason: "not-ready" };
  }
  if (currentProviderTurn?.status === "delivery-unknown") {
    return { ...base, status: "skipped", reason: "delivery-uncertain",
      error: currentProviderTurn.terminalReason ?? "Provider acceptance is unknown; no replay is permitted." };
  }

  if (currentProviderTurn?.status === "rejected") {
    return failRunDelivery(store, run, now, "runtime-failed",
      currentProviderTurn.terminalReason ?? "Provider rejected the input.");
  }
  if (currentProviderTurn !== null && currentProviderTurn.status !== "deferred") {
    const reason = currentProviderTurn.terminalReason
      ?? `Provider Turn ended with status ${currentProviderTurn.status} without recording its AgentRun result.`;
    // A terminal Provider projection without an application result is a
    // framework consistency failure, not evidence that the Agent omitted its
    // report. Keep the exact input fenced; never submit it again.
    return { ...base, status: "skipped", reason: "delivery-uncertain", error: reason };
  }
  const lastSubmitError = store.listEvents(task.id).filter((event) =>
    event.type === "runtime.agent-error" && event.payload.runId === run.id
    && event.payload.roleName === role.name && event.payload.phase === "turn-submit").at(-1);
  if (currentProviderTurn === null && lastSubmitError?.payload.inputDisposition === "unknown") {
    return { ...base, status: "skipped", reason: "delivery-uncertain", error: lastSubmitError.payload.message };
  }
  const deferredBeforeRegistration = lastSubmitError?.payload.inputDisposition === "not-accepted"
    && lastSubmitError.payload.registrationDisposition === "not-committed"
    && lastSubmitError.payload.errorName === "ProviderTurnBusyError";

  // Only a durable, exact busy/not-accepted disposition permits a new
  // transport attempt. Keep the business input and every earlier receipt.
  const attemptId = currentProviderTurn?.status === "deferred" || deferredBeforeRegistration
    ? `${initialAttemptId}/attempt/${randomUUID()}`
    : initialAttemptId;
  const existingSession = store.getRoleSession(task.id, role.name, run.effective.agentId);
  // The first attempted admission may already have opened this fixed native
  // Session. A busy retry resumes it; it does not repeat the original launch.
  const preparedHere = existingSession?.nativeSessionId !== undefined
    && store.listEvents(task.id).some((event) => event.type === "run.session-prepared"
      && event.payload.runId === run.id && event.payload.nativeSessionId === existingSession.nativeSessionId);
  const mode = (currentProviderTurn?.status === "deferred" || preparedHere) && existingSession?.nativeSessionId !== undefined
    ? "resume" : run.mode;
  let prepared: PreparedRoleDelivery | undefined;
  let submitted = false;
  try {
    const nativeSessionId = mode === "resume"
      ? requireResumeSession(role, run, existingSession)
      : undefined;
    prepared = await delivery.prepareRoleSession({
      taskId: task.id,
      roleName: role.name,
      agentId: run.effective.agentId,
      adapterId: run.effective.adapterId,
      effective: run.effective,
      workspace: run.effective.workspace.root,
      ...(run.workspace === undefined ? {} : { managedWorkspace: run.workspace }),
      // A Task owning no workspace by design states that explicitly, so the
      // launch does not read the absent workspace as a missing one and fail
      // closed (S27). Two distinct cases qualify: a Task activated with an
      // empty plan and binding no Project, and a Draft planning conversation,
      // which may already bind a Project but has not activated, so no worktree
      // exists or is owed yet. Declaring it free is what keeps the isolation
      // fence honest instead of letting it fail on a workspace nobody promised.
      ...(run.workspace === undefined
        && (isSchedulerPlanningDraft(task, run.purpose)
          || !taskOwnsManagedWorkspace(task))
        ? { workspaceFree: true as const }
        : {}),
      mode,
      runId: run.id,
      ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
      beforeHostStart: (preflight) => persistPreStartSession(
        store,
        task,
        role,
        run,
        existingSession,
        mode,
        preflight,
        now
      )
    });
    const preparedSession = prepared.session === undefined
      ? existingSession
      : validateRoleSession(role, run, existingSession, mode, prepared.session);
    store.saveRoleRunPrepared({
      task,
      role,
      run,
      session: preparedSession,
      now
    });

    const ready = await delivery.waitUntilReady(prepared);
    const readySession = validateRoleSession(role, run, existingSession, mode, ready.session);
    store.saveRoleRunPrepared({
      task,
      role,
      run,
      session: readySession,
      now
    });
    submitted = true;
    const outcome = await delivery.sendOnce({
      delivery: ready,
      receiptId: attemptId,
      text: serializeRunInputEnvelope(runInputEnvelope(run))
    });

    if (outcome.status === "pending") {
      // The original Host request is still in flight. Its durable submitting
      // attempt prevents another write; only the eventual receipt consumes
      // this mailbox input. A normal wait is neither failure nor acceptance.
      forget(delivery, task.id, role.name, run.id);
      return { ...base, status: "skipped", reason: "not-ready" };
    }
    if (outcome.status === "busy" || outcome.status === "unavailable") {
      if (outcome.status === "busy" && outcome.failure?.inputDisposition === "not-accepted") {
        store.recordAgentError({ taskId: task.id, roleName: role.name, runId: run.id,
          source: "host", phase: "turn-submit", message: outcome.failure.detail,
          raw: outcome.failure.raw ?? serializeAgentErrorRaw(outcome.failure),
          inputDisposition: "not-accepted", ...providerDeliveryFailureFacts(outcome.failure),
          attemptId }, now);
      }
      forget(delivery, task.id, role.name, run.id);
      return {
        ...base,
        status: "skipped",
        reason: outcome.status === "busy" ? "not-ready" : "runtime-unavailable"
      };
    }
    if (outcome.status === "rejected" || outcome.status === "delivery-unknown") {
      forget(delivery, task.id, role.name, run.id);
      const unknown = outcome.status === "delivery-unknown";
      const failure = outcome.failure;
      // The Host's own account of the failure. Without it the only honest
      // statement is that delivery did not complete — never that the Provider
      // rejected the input, which is one specific cause among many.
      const cause = failure === undefined
        ? `The Agent Host did not deliver the managed AgentRun (${outcome.status}) and reported no cause.`
        : formatProviderDeliveryFailure(failure);
      // This path is the common Provider write failure and previously left no
      // durable fact at all, so the cause was unrecoverable after the fact.
      store.recordAgentError({
        taskId: task.id,
        roleName: role.name,
        runId: run.id,
        source: "host",
        phase: failure?.phase ?? "turn-submit",
        message: cause,
        // The Host already serialized the complete redacted chain. Re-serializing
        // the failure object here would persist this layer's wrapper instead of
        // the original cause, which is the detail an authorized reader needs.
        raw: failure?.raw ?? serializeAgentErrorRaw(failure ?? cause),
        inputDisposition: failure?.inputDisposition ?? (unknown ? "unknown" : "not-accepted"),
        ...providerDeliveryFailureFacts(failure),
        attemptId
      }, now);
      if (unknown) return { ...base, status: "skipped", reason: "delivery-uncertain", error: cause };
      return failRunDelivery(
        store,
        run,
        now,
        "runtime-failed",
        cause
      );
    }
    forget(delivery, task.id, role.name, run.id);
    settleAcceptedRoleRunDispatch(store, run, dispatchToken);
    return {
      ...base,
      status: outcome.status === "sent" ? "delivered" : "already-delivered"
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Preserve the structured cause alongside the readable diagnosis.
    const causeName = innermostCauseName(error);
    store.recordAgentError({
      taskId: task.id,
      roleName: role.name,
      runId: run.id,
      source: error instanceof RuntimeLaunchError || error instanceof RuntimeLaunchFailure ? "host" : "yui",
      phase: submitted ? "turn-submit" : mode === "new" ? "session-start" : "session-restore",
      message,
      raw: serializeAgentErrorRaw(error),
      inputDisposition: submitted ? "unknown" : "not-accepted",
      // Nothing was submitted, so the Provider provably holds no registration
      // for this attempt; after a submit the Host owns that fact, not this layer.
      ...(submitted ? {} : { registrationDisposition: "not-committed" as const }),
      ...(error instanceof Error ? { errorName: error.name } : {}),
      ...(causeName === undefined ? {} : { causeName }),
      attemptId
    }, now);
    if (error instanceof RuntimeLifecycleBusyError
      || (error instanceof RuntimeLaunchError && error.retryable)) {
      return {
        ...base,
        status: "skipped",
        reason: error instanceof RuntimeLaunchError && error.reason === "writable-client"
          ? "writer-attached"
          : "runtime-unavailable",
        error: message
      };
    }
    forget(delivery, task.id, role.name, run.id);
    if (submitted) return { ...base, status: "skipped", reason: "delivery-uncertain", error: message };
    return failRunDelivery(
      store,
      run,
      now,
      "startup-failed",
      message
    );
  }
}

function failRunDelivery(
  store: SchedulerStorePort,
  run: SchedulerRun,
  now: Date,
  failureReason: import("../agentRun/agentRun.js").AgentRunFailureReason,
  summary: string
): ActiveRoleRunDeliveryResult {
  const disposition = store.saveRoleRunDeliveryFailure({
    taskId: run.taskId,
    roleName: run.roleName,
    agentId: run.effective.agentId,
    adapterId: run.effective.adapterId,
    runId: run.id,
    failureReason,
    summary,
    now
  });
  return {
    taskId: run.taskId,
    roleName: run.roleName,
    runId: run.id,
    status: disposition === "failed" ? "failed" : "skipped",
    reason: failureReason === "delivery-unknown" ? "delivery-uncertain" : "launch-failed",
    error: summary,
    ...(disposition === "failed" ? { terminalized: true } : {})
  };
}

function settleAcceptedRoleRunDispatch(
  store: SchedulerStorePort,
  run: SchedulerRun,
  expected?: RoleRunDispatchToken | null
): void {
  store.settleRoleRunDispatch({
    taskId: run.taskId,
    roleName: run.roleName,
    runId: run.id,
    ...(expected === undefined ? {} : { expected })
  });
}

function persistPreStartSession(
  store: SchedulerStorePort,
  task: SchedulerTask,
  role: SchedulerRole,
  run: SchedulerRun,
  existing: SchedulerRoleSession | null,
  mode: "new" | "resume",
  preflight: RuntimeLaunchPreflight,
  now: Date
): void {
  if (preflight.owner.scope !== "task" || preflight.owner.taskId !== task.id || preflight.owner.roleName !== role.name || preflight.runId !== run.id) {
    throw new Error(`Pre-start launch fence changed the active Role AgentRun: ${task.id}/${role.name}.`);
  }
  const session = preflight.nativeSessionId === undefined ? null : {
    agentId: preflight.agentId,
    adapterId: preflight.adapterId,
    nativeSessionId: preflight.nativeSessionId,
    ...(preflight.sessionTitle === undefined ? {} : { title: preflight.sessionTitle }),
    status: "active" as const,
    effective: preflight.effective
  };
  store.saveRoleRunPrepared({
    task,
    role,
    run,
    session: validateRoleSession(role, run, existing, mode, session),
    now
  });
}

function validateRoleSession(
  role: SchedulerRole,
  run: SchedulerRun,
  existing: SchedulerRoleSession | null,
  mode: "new" | "resume",
  session: SchedulerRoleSession | null
): SchedulerRoleSession | null {
  if (mode === "new" && session === null) return null;
  if (session === null || !hasText(session.nativeSessionId)) {
    throw new Error(`Ready Role session has no native session id: ${role.taskId}/${role.name}.`);
  }
  if (session.agentId !== run.effective.agentId
    || session.adapterId !== run.effective.adapterId) {
    throw new Error(`Ready Role session identity changed: ${role.taskId}/${role.name}.`);
  }
  const compatible = mode === "resume"
    ? roleSessionMayContinue(session.effective, run.effective)
    : sameEffectiveLaunch(session.effective, run.effective);
  if (!compatible) {
    throw new Error(`Ready Role session effective snapshot changed: ${role.taskId}/${role.name}.`);
  }
  if (mode === "resume" && session.nativeSessionId !== existing?.nativeSessionId) {
    throw new Error(`Role resume changed the fixed native session id: ${role.taskId}/${role.name}.`);
  }
  return {
    ...session,
    status: "active",
    ...(mode === "resume" && existing !== null ? { effective: existing.effective } : {})
  };
}

function requireResumeSession(
  role: SchedulerRole,
  run: SchedulerRun,
  session: SchedulerRoleSession | null
): string {
  if (session === null || !hasText(session.nativeSessionId)) {
    throw new Error(`Role resume has no fixed native session: ${role.taskId}/${role.name}.`);
  }
  if (!roleSessionMayContinue(session.effective, run.effective)) {
    throw new Error(`Role resume effective snapshot drifted: ${role.taskId}/${role.name}.`);
  }
  return session.nativeSessionId;
}

function forget(
  delivery: TmuxDeliveryPort,
  taskId: string,
  roleName: string,
  runId: string
): void {
  delivery.forgetPrepared?.({
    taskId,
    roleName,
    runId,
  });
}

function hasText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
