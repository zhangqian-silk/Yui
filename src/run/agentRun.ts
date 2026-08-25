import {
  validateEffectiveLaunchSnapshot,
  type EffectiveLaunchSnapshot
} from "../executor/effectiveLaunch.js";
import {
  formatAgentRunReceiptId,
  validateTaskRecordReference
} from "../task/taskRecordReference.js";
import type {
  LeaderRunDisposition,
  LeaderWaitReason
} from "../scheduler/actionability.js";
import {
  prepareProviderRetryDispatch,
  validateAgentRunProviderRetry,
  type AgentRunProviderRetry
} from "./providerRetry.js";
import {
  validateYieldReceipt,
  type YieldReceipt
} from "./yieldReceipt.js";
import {
  validateAgentRunControlRequest,
  type AgentRunControlRequest
} from "./runControlRequest.js";
import {
  validateManagedWorkspace,
  type ManagedWorkspace
} from "../worktree/managedWorkspace.js";
import {
  createRunAssignment,
  createRunBootstrapEnvelope,
  validateRunAssignment,
  validateRunBootstrapEnvelope,
  type RunAssignment,
  type RunBootstrapEnvelope
} from "../context/runContextContract.js";
import type { ContextSnapshotRef } from "../context/contextSnapshot.js";

export type DispatchMode = "new" | "resume";
export type AgentRunStatus = "active" | "yielded" | "failed";
export type AgentRunPurpose = "execution" | "review";

export type AgentRun = {
  /**
   * v8 replaces unbounded launch input with a durable Assignment and a bounded
   * transport Envelope. Task content is loaded through the exact Context API.
   */
  schemaVersion: 9;
  id: string;
  taskId: string;
  roleName: string;
  mode: DispatchMode;
  assignment: RunAssignment;
  bootstrapEnvelope: RunBootstrapEnvelope;
  purpose: AgentRunPurpose;
  workItemId?: string;
  reviewRoundId?: string;
  /** Frozen lineage inside the unified execution Group. */
  executionGroupId?: string;
  executionLaneId?: string;
  workspace?: ManagedWorkspace;
  /** Immutable actual launch configuration and provenance. */
  effective: EffectiveLaunchSnapshot;
  status: AgentRunStatus;
  /**
   * Set when tmux confirmed the receipt-backed transport push (bytes reached the
   * pane). Transport only — it proves the prompt was pushed, never that the
   * provider accepted it. A push without a later provider-accepted fold stays
   * pushed-but-unaccepted.
   */
  pushedAt?: string;
  /**
   * Set only after an exact, identity-matched durable provider-accepted fold
   * (UserPromptSubmit). This is the durable "delivered"
   * gate every consumer reads; transport alone never sets it.
   */
  deliveredAt?: string;
  /**
   * Receipt of the most recently dispatched input for this Run. It survives
   * retry-episode recovery so later lifecycle observations remain fenced to
   * the accepted continuation even after active retry counters are cleared.
   */
  deliveryReceiptId?: string;
  summary?: string;
  /**
   * Issue 04 durable in-place retry projection. Present only while an active
   * Run is being retried on its original Native Session; cleared at
   * terminalization.
   */
  providerRetry?: AgentRunProviderRetry;
  /** Bounded same-Session control input; never contains the Run Assignment. */
  controlRequest?: AgentRunControlRequest;
  /**
   * Issue 04 idempotent yield receipt. Present only on a yielded Run, written
   * in the same transaction as its terminal state.
   */
  yieldReceipt?: YieldReceipt;
  /**
   * Machine-derived disposition of a terminal Leader Run (Issue 05). Set at
   * yield/fail time so the Scheduler can tell whether a later scan brings any
   * new actionable fact. Absent on older Runs and on non-Leader Runs.
   */
  disposition?: LeaderRunDisposition;
  /**
   * Actionability digest observed by a terminal Leader Run. When the last
   * Leader Run ended waiting/blocked and a later scan computes the same
   * digest, the Scheduler stays silent instead of creating a new Run.
   */
  observedActionabilityDigest?: string;
  /** Optional structured wait reference for a waiting/blocked Leader Run. */
  waitReason?: LeaderWaitReason;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
};

export function createAgentRun(
  id: string,
  taskId: string,
  roleName: string,
  mode: DispatchMode,
  assignment: RunAssignment | string,
  now: Date,
  context: {
    workItemId?: string;
    purpose?: AgentRunPurpose;
    reviewRoundId?: string;
    executionGroupId?: string;
    executionLaneId?: string;
    workspace?: ManagedWorkspace;
    effective: EffectiveLaunchSnapshot;
  }
): AgentRun {
  if (mode !== "new" && mode !== "resume") {
    throw new Error(`Agent run dispatch mode is invalid: ${mode}.`);
  }
  const timestamp = now.toISOString();
  const normalizedAssignment = typeof assignment === "string"
    ? createRunAssignment({
        runId: id,
        roleName,
        purpose: context.purpose ?? "execution",
        action: context.purpose === "review"
          ? "review-round"
          : context.workItemId === undefined ? "leader-wake" : "execute-work-item",
        subject: {
          taskId,
          ...(context.workItemId === undefined ? {} : { workItemId: context.workItemId }),
          ...(context.purpose === "review"
            ? { reviewRoundId: context.reviewRoundId ?? `legacy-${id}` }
            : context.reviewRoundId === undefined ? {} : { reviewRoundId: context.reviewRoundId })
        },
        directive: assignment,
        deltaRefIds: []
      })
    : validateRunAssignment(assignment);
  return {
    schemaVersion: 9,
    id: requireSafeIdentity(id, "Agent run id"),
    taskId: requireSafeIdentity(taskId, "Task id"),
    roleName: requireSafeIdentity(roleName, "Role name"),
    mode,
    assignment: normalizedAssignment,
    bootstrapEnvelope: createRunBootstrapEnvelope(normalizedAssignment),
    purpose: context.purpose ?? "execution",
    ...(context.workItemId === undefined
      ? {}
      : { workItemId: requireSafeIdentity(context.workItemId, "Work item id") }),
    ...(context.reviewRoundId === undefined
      ? {}
      : { reviewRoundId: requireSafeIdentity(context.reviewRoundId, "ReviewRound id") }),
    ...(context.executionGroupId === undefined
      ? {}
      : { executionGroupId: requireSafeIdentity(context.executionGroupId, "ExecutionGroup id") }),
    ...(context.executionLaneId === undefined
      ? {}
      : { executionLaneId: requireSafeIdentity(context.executionLaneId, "ExecutionLane id") }),
    ...(context.workspace === undefined
      ? {}
      : { workspace: validateManagedWorkspace(context.workspace) }),
    effective: validateEffectiveLaunchSnapshot(context.effective),
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function isActiveAgentRun(run: AgentRun): boolean {
  return run.status === "active";
}

/** Binds a freshly created, not-yet-persisted Run to its frozen Context. */
export function withAgentRunContextSnapshot(
  run: AgentRun,
  snapshot: ContextSnapshotRef,
  deltaRefIds: readonly string[] = []
): AgentRun {
  if (run.status !== "active" || run.pushedAt !== undefined || run.deliveredAt !== undefined) {
    throw new Error(`Cannot bind Context Snapshot after Run delivery: ${run.id}.`);
  }
  const assignment = createRunAssignment({
    ...run.assignment,
    contextSnapshotRef: snapshot,
    deltaRefIds
  });
  return validateAgentRun(Object.freeze({
    ...run,
    assignment,
    bootstrapEnvelope: createRunBootstrapEnvelope(assignment)
  }));
}

export function markAgentRunPushed(run: AgentRun, now: Date): AgentRun {
  if (run.status !== "active") {
    throw new Error(`Cannot push a terminal Agent run: ${run.id}.`);
  }
  if (run.pushedAt !== undefined) return run;
  const timestamp = now.toISOString();
  return { ...run, pushedAt: timestamp, updatedAt: timestamp };
}

export function markAgentRunDelivered(run: AgentRun, now: Date): AgentRun {
  if (run.status !== "active") {
    throw new Error(`Cannot deliver a terminal Agent run: ${run.id}.`);
  }
  if (run.deliveredAt !== undefined) return run;
  const timestamp = now.toISOString();
  // Acceptance implies the prompt was pushed first; record both so a consumer
  // never sees delivered-without-pushed.
  return {
    ...run,
    ...(run.pushedAt === undefined ? { pushedAt: timestamp } : {}),
    deliveredAt: timestamp,
    updatedAt: timestamp
  };
}

export function validateAgentRun(run: AgentRun): AgentRun {
  if (run.schemaVersion !== 9) throw new Error("Agent run must use schemaVersion 9.");
  validateTaskRecordReference({ taskId: run.taskId, localId: run.id }, "agentRun");
  requireSafeIdentity(run.roleName, "Role name");
  if (run.mode !== "new" && run.mode !== "resume") {
    throw new Error(`Agent run dispatch mode is invalid: ${String(run.mode)}.`);
  }
  validateRunAssignment(run.assignment);
  validateRunBootstrapEnvelope(run.bootstrapEnvelope);
  if (run.assignment.runId !== run.id || run.assignment.roleName !== run.roleName
    || run.assignment.subject.taskId !== run.taskId) {
    throw new Error("Agent run Assignment identity does not match the Run.");
  }
  if (JSON.stringify(createRunBootstrapEnvelope(run.assignment))
    !== JSON.stringify(run.bootstrapEnvelope)) {
    throw new Error("Agent run Bootstrap Envelope does not match its Assignment.");
  }
  if (!["execution", "review"].includes(run.purpose)) {
    throw new Error(`Agent run purpose is invalid: ${String(run.purpose)}.`);
  }
  if (run.workItemId !== undefined) {
    validateTaskRecordReference({ taskId: run.taskId, localId: run.workItemId }, "workItem");
  }
  if (run.reviewRoundId !== undefined) {
    validateTaskRecordReference({ taskId: run.taskId, localId: run.reviewRoundId }, "reviewRound");
  }
  if ((run.executionGroupId === undefined) !== (run.executionLaneId === undefined)) {
    throw new Error("Agent run execution lineage is incomplete.");
  }
  if (run.executionGroupId !== undefined) {
    requireSafeIdentity(run.executionGroupId, "ExecutionGroup id");
    requireSafeIdentity(run.executionLaneId!, "ExecutionLane id");
  }
  if (run.workspace !== undefined) {
    validateManagedWorkspace(run.workspace);
    if (run.workspace.owner.taskId !== run.taskId) {
      throw new Error("Agent run workspace belongs to another Task.");
    }
    if (run.workspace.owner.type === "work-item"
      && run.workspace.owner.workItemId !== run.workItemId) {
      throw new Error("Agent run workspace belongs to another Work Item.");
    }
    if (run.workspace.owner.type === "work-item" && run.workItemId === undefined) {
      throw new Error("A WorkItem workspace requires a WorkItem Agent run reference.");
    }
    if (run.workspace.owner.type === "review-round" && run.purpose !== "review") {
      throw new Error("A ReviewRound workspace requires a review Agent run.");
    }
    if (run.workspace.owner.type === "integration-attempt") {
      throw new Error("An IntegrationAttempt workspace cannot be used by an Agent run.");
    }
    if (run.workspace.owner.type === "execution-lane") {
      if (run.workspace.owner.executionGroupId !== run.executionGroupId
        || run.workspace.owner.executionLaneId !== run.executionLaneId) {
        throw new Error("Agent run Execution Lane workspace lineage does not match the Run.");
      }
      if (run.workspace.owner.purpose === "execution"
        && run.workspace.owner.workItemId !== run.workItemId) {
        throw new Error("Agent run Execution Lane workspace WorkItem does not match the Run.");
      }
      if (run.workspace.owner.purpose === "review"
        && run.workspace.owner.reviewRoundId !== run.reviewRoundId) {
        throw new Error("Agent run review Lane workspace ReviewRound does not match the Run.");
      }
    }
    if (run.workspace.owner.type === "review-round"
      && run.workspace.owner.reviewRoundId !== run.reviewRoundId) {
      throw new Error(
        `Agent run ReviewRound workspace owner does not match ${run.reviewRoundId ?? "none"}.`
      );
    }
  }
  if (run.purpose === "review") {
    if (run.reviewRoundId === undefined) {
      throw new Error("A review Agent run requires a ReviewRound reference.");
    }
    if (run.workspace === undefined
      || !((run.workspace.owner.type === "review-round"
        && run.workspace.owner.reviewRoundId === run.reviewRoundId)
        || (run.workspace.owner.type === "execution-lane"
          && run.workspace.owner.purpose === "review"
          && run.workspace.owner.reviewRoundId === run.reviewRoundId))) {
      throw new Error(
        `A review Agent run requires its exact ReviewRound workspace owner: ${run.reviewRoundId}.`
      );
    }
    if (run.workspace.entries.length === 0
      || run.workspace.entries.some(({ access }) => access !== "write")) {
      throw new Error("A review Agent run requires only isolated writable workspace entries.");
    }
  } else {
    if (run.reviewRoundId !== undefined) {
      throw new Error("An execution Agent run cannot reference a ReviewRound.");
    }
    if (run.workspace?.owner.type === "review-round") {
      throw new Error("An execution Agent run cannot use a ReviewRound-owned workspace.");
    }
    if (run.workspace?.owner.type === "execution-lane" && run.workspace.owner.purpose !== "execution") {
      throw new Error("An execution Agent run cannot use a review Lane workspace.");
    }
  }
  validateEffectiveLaunchSnapshot(run.effective);
  if (run.workspace !== undefined
    && (run.effective.workspace.root !== run.workspace.root
      || JSON.stringify(run.effective.workspace.entries) !== JSON.stringify(run.workspace.entries))) {
    throw new Error("Agent run effective workspace does not match its managed workspace.");
  }
  if (run.purpose === "review") {
    if (run.effective.reviewRoundId !== run.reviewRoundId) {
      throw new Error("Review Agent run effective provenance does not match its ReviewRound.");
    }
    if (!run.workspace!.entries.some(
      ({ baseCommit }) => baseCommit === run.effective.reviewBaseCommit
    )) {
      throw new Error("Review Agent run effective base does not match its workspace.");
    }
  } else if (run.effective.reviewRoundId !== undefined) {
    throw new Error("Execution Agent run cannot carry Review effective provenance.");
  }
  if (!( ["active", "yielded", "failed"] as const).includes(run.status)) {
    throw new Error(`Agent run status is invalid: ${String(run.status)}.`);
  }
  requireTimestamp(run.createdAt, "Agent run createdAt");
  requireTimestamp(run.updatedAt, "Agent run updatedAt");
  if (run.pushedAt !== undefined) requireTimestamp(run.pushedAt, "Agent run pushedAt");
  if (run.deliveredAt !== undefined) {
    requireTimestamp(run.deliveredAt, "Agent run deliveredAt");
    // Acceptance can never precede its transport push.
    if (run.pushedAt === undefined) {
      throw new Error("Agent run deliveredAt requires a prior pushedAt.");
    }
  }
  if (run.deliveryReceiptId !== undefined) {
    requireText(run.deliveryReceiptId, "Agent run deliveryReceiptId");
    if (run.deliveryReceiptId.length > 256) {
      throw new Error("Agent run deliveryReceiptId exceeds 256 characters.");
    }
  }
  if (run.status === "active") {
    if (run.summary !== undefined || run.endedAt !== undefined) {
      throw new Error("An active Agent run cannot have terminal metadata.");
    }
    if (run.disposition !== undefined
      || run.observedActionabilityDigest !== undefined
      || run.waitReason !== undefined) {
      throw new Error("An active Agent run cannot carry Leader receipt metadata.");
    }
  } else {
    requireText(run.summary ?? "", "Agent run summary");
    requireTimestamp(run.endedAt ?? "", "Agent run endedAt");
    if (run.disposition !== undefined
      && !["progress", "waiting", "blocked", "completed"].includes(run.disposition)) {
      throw new Error(`Agent run disposition is invalid: ${String(run.disposition)}.`);
    }
    if (run.observedActionabilityDigest !== undefined) {
      requireText(run.observedActionabilityDigest, "Agent run observedActionabilityDigest");
    }
    if (run.waitReason !== undefined) {
      requireText(run.waitReason.kind, "Agent run waitReason kind");
      if (run.waitReason.ref !== undefined) {
        requireText(run.waitReason.ref, "Agent run waitReason ref");
      }
    }
  }
  if (run.providerRetry !== undefined) {
    validateAgentRunProviderRetry(run.providerRetry);
    if (run.status !== "active") {
      throw new Error("A terminal Agent run cannot carry a providerRetry projection.");
    }
  }
  if (run.controlRequest !== undefined) {
    validateAgentRunControlRequest(run.controlRequest);
    if (run.status !== "active") {
      throw new Error("A terminal Agent run cannot carry a controlRequest projection.");
    }
  }
  if (run.yieldReceipt !== undefined) {
    validateYieldReceipt(run.yieldReceipt);
    if (run.status !== "yielded") {
      throw new Error("An Agent run yield receipt requires a yielded Run.");
    }
  }
  return run;
}

export function yieldAgentRun(run: AgentRun, summary: string, now: Date): AgentRun {
  return finishAgentRun(run, "yielded", requireResultText(summary, "Agent run summary"), now);
}

export function failAgentRun(run: AgentRun, summary: string, now: Date): AgentRun {
  return finishAgentRun(run, "failed", requireResultText(summary, "Agent run summary"), now);
}

function finishAgentRun(
  run: AgentRun,
  status: Exclude<AgentRunStatus, "active">,
  summary: string,
  now: Date
): AgentRun {
  if (run.status !== "active") {
    throw new Error(`Agent run is already terminal: ${run.id}.`);
  }
  const timestamp = now.toISOString();
  const terminal = {
    ...run,
    status,
    summary,
    updatedAt: timestamp,
    endedAt: timestamp
  } as AgentRun;
  // A terminal Run no longer waits for a retry; the projection is cleared so
  // old and new readers agree the Run is settled.
  if (terminal.providerRetry !== undefined) {
    delete terminal.providerRetry;
  }
  if (terminal.controlRequest !== undefined) delete terminal.controlRequest;
  return terminal;
}

/**
 * Attaches (or advances) the Issue 04 in-place retry projection on an active
 * Run. The Run stays `active`; only the projection changes.
 */
export function withProviderRetry(
  run: AgentRun,
  retry: AgentRunProviderRetry
): AgentRun {
  if (run.status !== "active") {
    throw new Error(`Cannot schedule provider retry on a terminal Agent run: ${run.id}.`);
  }
  return validateAgentRun({ ...run, providerRetry: retry });
}

/**
 * Reopens an active retry-waiting Run for another in-place attempt on its
 * original Native Session. The original Run transport/acceptance timestamps
 * remain historical facts; the new delivery receipt and `dispatching` retry
 * state make the delivery path send only the short continuation envelope.
 */
export function reopenRunForProviderRetry(
  run: AgentRun,
  receiptId: string,
  now: Date,
  mode: "new" | "resume" = "resume"
): AgentRun {
  if (run.status !== "active" || run.providerRetry === undefined) {
    throw new Error(`Agent run is not waiting for a provider retry: ${run.id}.`);
  }
  const timestamp = now.toISOString();
  const {
    providerRetry,
    ...rest
  } = run;
  return validateAgentRun({
    ...rest,
    mode,
    deliveryReceiptId: receiptId,
    updatedAt: timestamp,
    providerRetry: prepareProviderRetryDispatch(providerRetry, receiptId, now)
  });
}

/** Any exact correlated provider progress ends the active consecutive-failure episode. */
export function clearProviderRetryOnProgress(run: AgentRun): AgentRun {
  if (run.providerRetry === undefined) return run;
  const { providerRetry: _providerRetry, ...rest } = run;
  return validateAgentRun(rest as AgentRun);
}

export function agentRunDeliveryReceiptId(run: AgentRun): string {
  return run.deliveryReceiptId
    ?? run.controlRequest?.receiptId
    ?? run.providerRetry?.lastRetryReceiptId
    ?? formatAgentRunReceiptId(run.taskId, run.id);
}

export function withAgentRunControlRequest(
  run: AgentRun,
  request: AgentRunControlRequest,
  now: Date
): AgentRun {
  if (run.status !== "active" || run.providerRetry !== undefined) {
    throw new Error(`Agent run cannot accept a control request: ${run.id}.`);
  }
  return validateAgentRun({
    ...run,
    mode: "resume",
    deliveryReceiptId: request.receiptId,
    controlRequest: validateAgentRunControlRequest(request),
    updatedAt: now.toISOString()
  });
}

/** Attaches the Issue 04 yield receipt to a yielded Run. */
export function withYieldReceipt(run: AgentRun, receipt: YieldReceipt): AgentRun {
  if (run.status !== "yielded") {
    throw new Error(`Cannot attach a yield receipt to a non-yielded Agent run: ${run.id}.`);
  }
  return validateAgentRun({ ...run, yieldReceipt: receipt });
}

function requireSafeIdentity(value: string, label: string): string {
  const normalized = requireText(value, label);
  if (["__proto__", "prototype", "constructor", ".", ".."].includes(normalized)
    || /[\/\\\0]/.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} is invalid.`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  return normalized;
}

/** Result transport preserves the provider's complete text, including outer whitespace. */
function requireResultText(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} is invalid.`);
  if (value.trim().length === 0) throw new Error(`${label} is required.`);
  return value;
}

function requireTimestamp(value: string, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
}
