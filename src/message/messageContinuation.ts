import { isDeepStrictEqual } from "node:util";
import type { TaskStore } from "../storage/taskStore.js";
import type { TaskMessage, TaskMessageRecipient } from "./message.js";
import { createRun, withRunContextSnapshot, type AgentRun } from "../agentRun/agentRun.js";
import { createRunInput } from "../context/runInputContract.js";
import { contextContentDigest, contextSnapshotRef, createContextSnapshot } from "../context/contextSnapshot.js";
import { roleSessionMayContinue } from "../executor/effectiveLaunch.js";
import { enqueueRoleRunDispatch } from "../coordination/workMailboxQueue.js";
import { createTaskEvent } from "../event/taskEvent.js";
import { validateExactRunReviewRound } from "../lifecycle/exactRunTerminalization.js";
import { sourceRunContextValue } from "../context/sourceRunContext.js";
import { requireManagedTaskCaller } from "../runtime/managedCaller.js";
import { runtimeObservationFromTaskEvent } from "../runtime/runtimeObservation.js";

export function resolveMessageRecipient(
  store: TaskStore, taskId: string, roleName: string,
  scope: Readonly<{ workItemId?: string; reviewRoundId?: string }>
): TaskMessageRecipient & Readonly<{ ownerRunId: string }> {
  if (scope.reviewRoundId !== undefined) {
    const round = store.getReviewRound(taskId, scope.reviewRoundId);
    if (round === null) throw new Error("ReviewRound is unavailable in this Task.");
    if (scope.workItemId !== undefined && scope.workItemId !== round.workItemId) throw new Error("ReviewRound WorkItem scope mismatch.");
    scope = { reviewRoundId: scope.reviewRoundId, ...(round.workItemId === undefined ? {} : { workItemId: round.workItemId }) };
  }
  if (scope.workItemId === undefined && scope.reviewRoundId === undefined) {
    throw new Error("Recipient requires --work-item or --review-round; Message does not establish an Assignment.");
  }
  const previous = store.listRuns(taskId).filter((run) =>
    run.roleName === roleName && run.workItemId === scope.workItemId
    && run.reviewRoundId === scope.reviewRoundId).at(-1);
  if (previous === undefined) throw new Error("No existing Dispatch owns this Role and work scope.");
  return { roleName, ownerRunId: previous.id, ...scope };
}

/** Bounded diagnosis, not automatic ownership repair. */
export function messageContinuationBlocker(store: TaskStore, message: TaskMessage): string | undefined {
  const target = message.recipient;
  if (target?.ownerRunId === undefined) return "recipient-assignment-missing";
  const task = store.getTask(message.taskId);
  if (task?.status !== "active") return `task-${task?.status ?? "missing"}`;
  if (task.executionGate.state !== "enabled") return "execution-disabled";
  const owner = store.getRun(message.taskId, target.ownerRunId);
  if (owner === null || owner.roleName !== target.roleName || owner.workItemId !== target.workItemId
    || owner.reviewRoundId !== target.reviewRoundId) return "owner-assignment-mismatch";
  if (owner.result?.failureReason === "delivery-unknown") return "owner-acceptance-unknown";
  if (owner.executionGroupId !== undefined || owner.sourceExecutionGroupId !== undefined) {
    return "replicated-assignment-requires-explicit-dispatch";
  }
  if (target.workItemId !== undefined) {
    const work = store.getWorkItem(message.taskId, target.workItemId);
    if (work?.status !== "open") return `work-item-${work?.status ?? "missing"}`;
    if (target.reviewRoundId === undefined && work.assignee !== target.roleName) return "owner-changed";
    if (target.reviewRoundId === undefined && !isDeepStrictEqual(
      [...work.writeProjectIds].sort(), [...owner.effective.writeProjectIds].sort())) return "assignment-scope-changed";
    if (target.reviewRoundId === undefined && owner.workspace !== undefined) {
      const workspace = target.roleName === "leader"
        ? store.getTaskWorkspace(message.taskId) : store.getWorkItemWorkspace(message.taskId, target.workItemId);
      const identity = (entries: NonNullable<AgentRun["workspace"]>["entries"]) => entries.map((entry) => ({
        projectId: entry.projectId, path: entry.path, access: entry.access, branch: entry.branch
      }));
      if (workspace?.root !== owner.workspace.root
        || !isDeepStrictEqual(identity(workspace.entries), identity(owner.workspace.entries))) {
        return "assignment-workspace-changed";
      }
    }
    const ownershipAt = message.handovers?.at(-1)?.at ?? message.createdAt;
    if (target.reviewRoundId === undefined && store.listEvents(message.taskId).some((event) =>
      event.type === "work.edited" && event.payload.workItemId === target.workItemId
      && event.payload.fields?.split(",").includes("assignee")
      && event.createdAt > ownershipAt && event.payload.previous !== event.payload.current)) return "owner-changed";
  }
  const latest = store.listRuns(message.taskId).filter((run) =>
    run.workItemId === owner.workItemId && run.reviewRoundId === owner.reviewRoundId
    && run.roleName === owner.roleName).at(-1);
  if (latest !== undefined && latest.id !== owner.id
    && latest.inputs[0]?.input.source.channel !== "message-continuation") return "assignment-changed";
  if (target.reviewRoundId !== undefined) {
    const round = store.getReviewRound(message.taskId, target.reviewRoundId);
    if (round === null) return "review-round-missing";
    if (round.scope === "task") {
      if (round.taskCandidate?.projects.some((project) =>
        task.projectBindings.find((binding) => binding.projectId === project.projectId)?.currentCommit !== project.commit)) {
        return "review-candidate-stale";
      }
    } else {
      const item = store.getWorkItem(message.taskId, round.workItemId!);
      if (item?.candidates.at(-1)?.id !== round.candidateId) return "review-candidate-stale";
    }
    const validation = validateExactRunReviewRound(store, latest ?? owner, { allowTerminal: true });
    if (validation.disposition !== "applied") return validation.reason ?? "review-candidate-stale";
  }
  return undefined;
}

/**
 * The one gate that decides when a claimed interrupt-then handoff may be
 * delivered (decision-3 §4). It is keyed on the exact interrupted native Turn —
 * not on the recipient's owner Assignment and not on a Run's business status —
 * so the terminal proof is about the Turn that was actually cancelled:
 * - `ready`   — the native Turn stopped and its cancel outcome is knowable; the
 *               handoff may deliver.
 * - `waiting` — the native Turn is still in flight; hold silently until it stops.
 * - `unknown` — the cancel outcome is unprovable (delivery-unknown); the handoff
 *               is never released or replayed across that boundary.
 * - `missing` — the target can never prove its terminal.
 * A plain queued Message (no claim) is always `ready` here; its own delivery
 * gates live in messageContinuationBlocker.
 *
 * The proof is composite by necessity (message-5 gap C). Native execution
 * termination is read from the live ProviderTurn, re-verified by attemptId,
 * because a Run's business status can flip to failed while its native Turn is
 * still running — the old AgentRun-only gate could release across a Turn that had
 * not actually stopped. When the live binding no longer holds that exact Turn, the
 * proof falls back to the durable native terminal observation keyed by the target
 * attemptId — never to the AgentRun's business status and never to a replacement
 * Turn's existence, both of which can be true while the target's native execution
 * has not stopped (decision-3 §4/§8, "requested != stopped"). The cancel's
 * *outcome* (clean vs delivery-unknown) lives on the owning AgentRun's
 * failureReason when a Run owns the Turn, because a settled ProviderTurn — or a
 * durable native terminal — preserves only completed/failed/cancelled and cannot
 * itself carry delivery-unknown.
 */
export function interruptThenTerminalState(
  store: TaskStore, message: TaskMessage
): "ready" | "waiting" | "unknown" | "missing" {
  const claim = message.interruptThen;
  if (claim === undefined) return "ready";
  const roleName = claim.targetRoleName;
  const sessions = store.getTaskRoleSessionSet(message.taskId, roleName);
  const session = sessions?.sessions[sessions.activeAgentId];
  const binding = sessions?.providerBinding;
  if (session?.status !== "active" || session.nativeSessionId !== claim.targetNativeSessionId
    || session.agentId !== claim.targetAgentId || session.adapterId !== claim.targetAdapterId
    || binding?.authority.owner !== "controller"
    || binding.authority.epoch !== claim.targetAuthorityEpoch
    || binding.authority.holderId !== claim.targetAuthorityHolderId) return "missing";
  const turn = binding.run;
  const owner = claim.targetRunId === undefined ? null : store.getRun(message.taskId, claim.targetRunId);
  if (claim.targetRunId !== undefined && owner === null) return "missing";
  // Primary proof: the exact interrupted native Turn, identity re-verified by
  // attemptId. While it is still present — in flight (submitting/accepted) or its
  // own acceptance unproven (delivery-unknown) — the native execution has not
  // stopped, so the handoff waits no matter what the Run's status claims.
  if (turn !== null && turn.attemptId === claim.targetAttemptId) {
    if (["submitting", "accepted", "delivery-unknown"].includes(turn.status)) return "waiting";
    // The native Turn stopped. Its cancel outcome may still be unprovable; that
    // is recorded on the owning AgentRun, never on the settled ProviderTurn.
    return ["completed", "failed", "cancelled"].includes(turn.status)
      && owner?.result?.failureReason !== "delivery-unknown" ? "ready" : "unknown";
  }
  // The live binding no longer holds the target native Turn — a later Turn
  // occupies it, or the binding's run pointer is gone. decision-3 §4/§8: a
  // replacement Turn's mere existence is NOT proof the target's native execution
  // stopped ("requested != stopped"; native quiescence is never inferred from a
  // new Turn's existence, and never from the owning AgentRun's business status).
  // The only protocol-proven stop is the durable, immutable native terminal
  // observation keyed by the exact target attemptId, written when the Provider
  // Host observed the Turn actually terminate.
  const nativeStopped = store.listEvents(message.taskId)
    .map(runtimeObservationFromTaskEvent)
    .some((observation) => observation !== null
      && (observation.kind === "turn.completed" || observation.kind === "turn.failed"
        || observation.kind === "turn.cancelled")
      && observation.fence.roleName === roleName
      && observation.fence.nativeSessionId === claim.targetNativeSessionId
      && (claim.targetNativeTurnId === undefined || observation.fence.nativeTurnId === claim.targetNativeTurnId)
      && observation.fence.receiptId === claim.targetAttemptId);
  if (nativeStopped) {
    // Proven stopped. Its cancel outcome (clean vs delivery-unknown) is recorded on
    // the owning AgentRun, never on the settled native terminal itself — the same
    // composite the primary path reads once native termination is proven.
    return owner?.result?.failureReason === "delivery-unknown" ? "unknown" : "ready";
  }
  // No durable proof the target native Turn stopped. Hold silently while an owning
  // Run could still produce that terminal; a later business-terminal or a
  // replacement Turn must never release it. With nothing owning the Turn and no
  // durable terminal, its stop is unobservable and the claim can never prove a
  // safe boundary — never released or replayed either way.
  return owner !== null ? "waiting" : "missing";
}

/** Called in the Controller's ordinary reconciliation transaction. Messages
 * remain the pending authority; Mailbox is only the existing scheduling hint.
 * Reserving inputs and creating the next Run is one atomic effect. */
export function prepareMessageContinuations(store: TaskStore, taskId: string, now: Date, roleName: string): void {
  const pending = store.listMessages(taskId).filter((message) =>
    message.recipient?.roleName === roleName && message.recipient.ownerRunId !== undefined
    && message.continuation?.runId === undefined
    // A steer targets the exact current native turn, never a queued next Run.
    // If its live attempt did not submit, the message stays saved for the
    // Leader to re-choose (§1/§8); Core never silently turns it into a queue.
    && message.inputControl?.action !== "steer");
  for (const message of pending) {
    const recipient = message.recipient!;
    const blocker = messageContinuationBlocker(store, message);
    if (blocker !== undefined) {
      markNotDelivered(store, message, blocker);
      continue;
    }
    if (store.getActiveRun(taskId, recipient.roleName) !== null) continue;
    const owner = store.getRun(taskId, recipient.ownerRunId!)!;
    const sessions = store.getTaskRoleSessionSet(taskId, recipient.roleName);
    const session = sessions?.sessions[owner.effective.agentId];
    const provider = sessions?.providerBinding;
    if (provider?.authority.owner === "human" || provider?.authority.owner === "unknown"
      || (provider?.run !== null && provider?.run !== undefined
        && ["submitting", "accepted", "delivery-unknown"].includes(provider.run.status))) continue;
    if (session?.status !== "active" || sessions?.activeAgentId !== owner.effective.agentId
      || store.getRole(taskId, recipient.roleName)?.activeAgentId !== owner.effective.agentId
      || !roleSessionMayContinue(session.effective, owner.effective)) {
      markNotDelivered(store, message, "compatible-session-unavailable");
      continue;
    }
    // Reuse the same current-Session authority gate as Task-local actions.
    // Matching Agent/effective flags alone do not undo explicit revocation.
    requireManagedTaskCaller(store, {
      YUI_SESSION_SCOPE: "task", YUI_TASK_ID: taskId, YUI_ROLE: recipient.roleName,
      YUI_NATIVE_SESSION_ID: session.nativeSessionId, YUI_WORKSPACE: owner.effective.workspace.root
    });
    const originalNativeSessionId = store.listEvents(taskId).filter((event) => event.type === "run.session-prepared"
        && event.payload.runId === owner.id && event.payload.roleName === owner.roleName)
        .at(-1)?.payload.nativeSessionId ?? owner.result?.provider?.conversationId;
    if (originalNativeSessionId === undefined || originalNativeSessionId !== session.nativeSessionId) {
      markNotDelivered(store, message, originalNativeSessionId === undefined
        ? "owner-session-unobserved" : "owner-session-changed");
      continue;
    }
    // decision-3 §4 ordering. Split this recipient's deliverable Messages into
    // the explicit interrupt-then handoffs and the ordinary queue. A handoff is
    // released only after its exact interrupted AgentRun reaches a proven
    // terminal, and the ordinary queue must never preempt a live handoff.
    const recipientPending = pending.filter((entry) => isDeepStrictEqual(entry.recipient, recipient)
      && messageContinuationBlocker(store, entry) === undefined);
    const thenClaims = recipientPending.filter((entry) => entry.interruptThen !== undefined);
    let handoffWaiting = false;
    const readyThen: TaskMessage[] = [];
    for (const claim of thenClaims) {
      const state = interruptThenTerminalState(store, claim);
      if (state === "ready") readyThen.push(claim);
      else if (state === "waiting") handoffWaiting = true;
      // A claim whose target can never prove its terminal fails visibly and
      // stops holding the queue; it is never released or replayed.
      else markNotDelivered(store, claim, state === "unknown"
        ? "interrupt-then-target-delivery-unknown" : "interrupt-then-target-missing");
    }
    // Hold the entire recipient — including the ordinary queue — while any
    // handoff still awaits its interrupted Turn's proven terminal.
    if (handoffWaiting) continue;
    // A ready handoff delivers in its own round ahead of the ordinary queue, so
    // the old queue only follows once the handoff has been delivered.
    const batch = (readyThen.length > 0
      ? readyThen
      : recipientPending.filter((entry) => entry.interruptThen === undefined)).slice(0, 16);
    if (batch.length === 0) continue;
    const previous = store.listRuns(taskId).filter((run) => run.roleName === owner.roleName
      && run.workItemId === owner.workItemId && run.reviewRoundId === owner.reviewRoundId).at(-1)!;
    const baselineRef = previous.inputs[0]?.input.contextSnapshotRef;
    const baseline = baselineRef === undefined ? null : store.getContextSnapshot(taskId, baselineRef.id);
    if (baseline === null || baseline.digest !== baselineRef!.digest) {
      markNotDelivered(store, message, "assignment-context-unavailable");
      continue;
    }
    const runId = store.nextRunId(taskId);
    const round = owner.reviewRoundId === undefined ? null : store.getReviewRound(taskId, owner.reviewRoundId);
    const continuingRound = round === null ? null : (() => {
      const { endedAt: _endedAt, failure: _failure, ...current } = round;
      return { ...current, status: "running" as const, reviewerRunId: runId };
    })();
    const priorMessages = baseline.resources.filter((entry) => entry.ref.store === "task-message").slice(-16);
    const source = sourceRunContextValue(previous);
    const resources = [...baseline.resources.filter((entry) =>
      entry.ref.store !== "task-message" && entry.ref.store !== "source-run"
      && !(continuingRound !== null && entry.ref.store === "review-round" && entry.ref.refId === continuingRound.id)),
      ...(continuingRound === null ? [] : [{ ref: { layer: "L3" as const, store: "review-round",
        refId: continuingRound.id, revision: now.toISOString(), digest: contextContentDigest(continuingRound),
        summary: `ReviewRound ${continuingRound.id}` }, value: continuingRound }]),
      ...priorMessages,
      { ref: { layer: "L4" as const, store: "source-run", refId: previous.id,
        revision: previous.updatedAt, digest: contextContentDigest(source), summary: `Previous result ${previous.id}` }, value: source },
      ...batch.map((entry) => ({
        ref: { layer: "L4" as const, store: "task-message", refId: entry.id,
          revision: entry.createdAt, digest: contextContentDigest(entry), summary: `Message ${entry.id}` },
        value: entry
      }))];
    const latestSnapshot = store.listContextSnapshots(taskId).filter((entry) =>
      entry.scope === baseline.scope && entry.scopeRef === baseline.scopeRef).at(-1);
    const snapshot = createContextSnapshot({
      ...baseline, id: store.nextContextSnapshotId(taskId),
      sequence: (latestSnapshot?.sequence ?? baseline.sequence) + 1,
      parentRef: contextSnapshotRef(baseline), frozenAt: now, frozenBy: "controller",
      resources, refs: resources.map(({ ref }) => ref)
    });
    store.saveContextSnapshot(snapshot);
    const run = withRunContextSnapshot(createRun(runId, taskId, recipient.roleName, "resume",
      createRunInput({ source: { type: "yui", channel: "message-continuation" },
        directive: `Continue the same Assignment in its existing workspace. Read Messages ${batch.map((m) => m.id).join(", ")} from this exact Context. Message receipt is not implementation or acceptance.`,
        deltaRefIds: batch.map((entry) => entry.id) }), now, copyAssignment(owner)),
    contextSnapshotRef(snapshot), batch.map((entry) => entry.id));
    store.saveRun(run);
    store.saveActiveRun(run);
    if (continuingRound !== null) store.saveReviewRound(taskId, continuingRound);
    for (const entry of batch) store.updateMessage(taskId, { ...entry, continuation: { runId } });
    enqueueRoleRunDispatch(store, { taskId, roleName: run.roleName, runId,
      reason: "message-continuation", occurredAt: now });
    store.saveEvent(taskId, createTaskEvent(store.nextEventId(taskId), taskId,
      "message.continuation", { runId, roleName: run.roleName, messageIds: batch.map((entry) => entry.id).join(",") }, now));
  }
}

function copyAssignment(run: AgentRun) {
  return { purpose: run.purpose, effective: run.effective,
    ...(run.workItemId === undefined ? {} : { workItemId: run.workItemId }),
    ...(run.reviewRoundId === undefined ? {} : { reviewRoundId: run.reviewRoundId }),
    ...(run.workspace === undefined ? {} : { workspace: run.workspace }) };
}

function markNotDelivered(store: TaskStore, message: TaskMessage, reason: string): void {
  if (message.continuation?.notDeliveredReason === reason) return;
  store.updateMessage(message.taskId, { ...message, continuation: { notDeliveredReason: reason } });
}
