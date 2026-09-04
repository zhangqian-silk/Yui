import {
  validateEffectiveLaunchSnapshot,
  type EffectiveLaunchSnapshot
} from "../executor/effectiveLaunch.js";
import { validateTaskRecordReference } from "../task/taskRecordReference.js";
import {
  validateManagedWorkspace,
  type ManagedWorkspace
} from "../worktree/managedWorkspace.js";
import {
  createTurnInput,
  createTurnInputEnvelope,
  validateTurnInput,
  type TurnInput,
  type TurnInputEnvelope
} from "../context/turnInputContract.js";
import type { ContextSnapshotRef } from "../context/contextSnapshot.js";
import type { ExecutionLaneGitSnapshot } from "../repository/executionLaneGitSnapshot.js";
import {
  MAX_TURN_RESULT_OUTPUT_BYTES,
  transportAgentResult
} from "../domain/agentResultTransport.js";
export {
  MAX_TURN_RESULT_OUTPUT_BYTES,
  transportAgentResult,
  type TransportedAgentResult
} from "../domain/agentResultTransport.js";

export type DispatchMode = "new" | "resume";
export type TurnStatus = "active" | "completed" | "failed";
export type TurnPurpose = "execution" | "review";
export type TurnFailureReason =
  | "startup-failed"
  | "runtime-failed"
  | "delivery-unknown"
  | "missing-result"
  | "cancelled";

export type TurnProviderResult = Readonly<{
  providerNamespace: string;
  accountScope: string;
  conversationId: string;
  activationId: string;
  nativeTurnId: string;
  status: "completed" | "failed" | "cancelled";
}>;

export type TurnSystemEvidence = Readonly<{
  workspaceSnapshot?: ExecutionLaneGitSnapshot;
}>;

/**
 * The automatically observed result of one managed Provider Turn. It is owned
 * by Turn; Provider Session state and Task/WorkItem acceptance remain
 * separate authorities.
 */
export type TurnResult = Readonly<{
  schemaVersion: 2;
  output: string;
  completedAt: string;
  provider?: TurnProviderResult;
  /** Objective evidence produced and validated by Core, never parsed from Agent output. */
  systemEvidence?: TurnSystemEvidence;
  failureReason?: TurnFailureReason;
}>;

export type TurnInputRecord = Readonly<{
  sequence: number;
  submittedAt: string;
  input: TurnInput;
}>;

export type Turn = {
  /** v5 stores Agent output opaquely and only Core-authored system evidence. */
  schemaVersion: 5;
  id: string;
  taskId: string;
  roleName: string;
  mode: DispatchMode;
  /** Every provider-visible input, including mid-Turn Yui steer; reasoning is omitted. */
  inputs: readonly TurnInputRecord[];
  purpose: TurnPurpose;
  workItemId?: string;
  reviewRoundId?: string;
  /** Frozen lineage inside the unified execution Group. */
  executionGroupId?: string;
  executionLaneId?: string;
  /** The settled replicated Group whose frozen Producer results this main Turn synthesizes. */
  sourceExecutionGroupId?: string;
  workspace?: ManagedWorkspace;
  /** Immutable actual launch configuration and provenance. */
  effective: EffectiveLaunchSnapshot;
  status: TurnStatus;
  result?: TurnResult;
  createdAt: string;
  updatedAt: string;
};

export function createTurn(
  id: string,
  taskId: string,
  roleName: string,
  mode: DispatchMode,
  input: TurnInput,
  now: Date,
  context: {
    workItemId?: string;
    purpose?: TurnPurpose;
    reviewRoundId?: string;
    executionGroupId?: string;
    executionLaneId?: string;
    sourceExecutionGroupId?: string;
    workspace?: ManagedWorkspace;
    effective: EffectiveLaunchSnapshot;
  }
): Turn {
  if (mode !== "new" && mode !== "resume") {
    throw new Error(`Turn dispatch mode is invalid: ${mode}.`);
  }
  const timestamp = now.toISOString();
  const normalizedInput = validateTurnInput(input);
  return {
    schemaVersion: 5,
    id: requireSafeIdentity(id, "Turn id"),
    taskId: requireSafeIdentity(taskId, "Task id"),
    roleName: requireSafeIdentity(roleName, "Role name"),
    mode,
    inputs: [turnInputRecord(normalizedInput, 1, timestamp)],
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
    ...(context.sourceExecutionGroupId === undefined
      ? {}
      : {
          sourceExecutionGroupId: requireSafeIdentity(
            context.sourceExecutionGroupId,
            "Source ExecutionGroup id"
          )
        }),
    ...(context.workspace === undefined
      ? {}
      : { workspace: validateManagedWorkspace(context.workspace) }),
    effective: validateEffectiveLaunchSnapshot(context.effective),
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function isActiveTurn(run: Turn): boolean {
  return run.status === "active";
}

/** Binds a freshly created, not-yet-persisted Turn to its frozen Context. */
export function withTurnContextSnapshot(
  run: Turn,
  snapshot: ContextSnapshotRef,
  deltaRefIds: readonly string[] = []
): Turn {
  const initial = run.inputs[0]!;
  if (run.status !== "active" || initial.input.contextSnapshotRef !== undefined) {
    throw new Error(`Cannot replace the Turn Context Snapshot: ${run.id}.`);
  }
  const input = createTurnInput({
    ...initial.input,
    contextSnapshotRef: snapshot,
    deltaRefIds
  });
  return validateTurn(Object.freeze({
    ...run,
    inputs: [turnInputRecord(input, 1, initial.submittedAt), ...run.inputs.slice(1)]
  }));
}

export function appendTurnInput(run: Turn, input: TurnInput, now: Date): Turn {
  validateTurn(run);
  if (run.status !== "active") throw new Error(`Cannot append input to terminal Turn: ${run.id}.`);
  const timestamp = now.toISOString();
  if (Date.parse(timestamp) < Date.parse(run.updatedAt)) {
    throw new Error("Turn input timestamp moved backwards.");
  }
  return validateTurn({
    ...run,
    inputs: [...run.inputs, turnInputRecord(input, run.inputs.length + 1, timestamp)],
    updatedAt: timestamp
  });
}

/** Derives Provider-visible identity from the Turn, the sole semantic owner. */
export function turnInputEnvelope(run: Turn, sequence = 1): TurnInputEnvelope {
  validateTurn(run);
  const record = run.inputs[sequence - 1];
  if (record === undefined) throw new Error(`Turn input does not exist: ${run.id}/${sequence}.`);
  return createTurnInputEnvelope(turnEnvelopeContext(run), record.input);
}

export function validateTurn(run: Turn): Turn {
  rejectUnknownFields(run as unknown as Record<string, unknown>, [
    "schemaVersion",
    "id",
    "taskId",
    "roleName",
    "mode",
    "inputs",
    "purpose",
    "workItemId",
    "reviewRoundId",
    "executionGroupId",
    "executionLaneId",
    "sourceExecutionGroupId",
    "workspace",
    "effective",
    "status",
    "result",
    "createdAt",
    "updatedAt"
  ], "Turn");
  if (run.schemaVersion !== 5) throw new Error("Turn must use schemaVersion 5.");
  validateTaskRecordReference({ taskId: run.taskId, localId: run.id }, "turn");
  requireSafeIdentity(run.roleName, "Role name");
  if (run.mode !== "new" && run.mode !== "resume") {
    throw new Error(`Turn dispatch mode is invalid: ${String(run.mode)}.`);
  }
  if (!Array.isArray(run.inputs) || run.inputs.length === 0) {
    throw new Error("Turn requires at least one input.");
  }
  for (const [index, record] of run.inputs.entries()) {
    if (record.sequence !== index + 1) throw new Error("Turn input sequence is invalid.");
    requireTimestamp(record.submittedAt, "Turn input submittedAt");
    validateTurnInput(record.input);
    if (index > 0 && Date.parse(record.submittedAt) < Date.parse(run.inputs[index - 1]!.submittedAt)) {
      throw new Error("Turn input timestamps moved backwards.");
    }
  }
  if (!["execution", "review"].includes(run.purpose)) {
    throw new Error(`Turn purpose is invalid: ${String(run.purpose)}.`);
  }
  if (run.workItemId !== undefined) {
    validateTaskRecordReference({ taskId: run.taskId, localId: run.workItemId }, "workItem");
  }
  if (run.reviewRoundId !== undefined) {
    validateTaskRecordReference({ taskId: run.taskId, localId: run.reviewRoundId }, "reviewRound");
  }
  if ((run.executionGroupId === undefined) !== (run.executionLaneId === undefined)) {
    throw new Error("Turn execution lineage is incomplete.");
  }
  if (run.executionGroupId !== undefined) {
    requireSafeIdentity(run.executionGroupId, "ExecutionGroup id");
    requireSafeIdentity(run.executionLaneId!, "ExecutionLane id");
  }
  if (run.sourceExecutionGroupId !== undefined) {
    requireSafeIdentity(run.sourceExecutionGroupId, "Source ExecutionGroup id");
    if ((run.purpose === "execution" && run.workItemId === undefined)
      || (run.purpose === "review" && run.reviewRoundId === undefined)) {
      throw new Error("A source ExecutionGroup requires a main execution or review Turn.");
    }
    if (run.executionGroupId !== undefined || run.executionLaneId !== undefined) {
      throw new Error("A main Turn cannot also be an Execution Lane Turn.");
    }
  }
  if (run.workspace !== undefined) {
    validateManagedWorkspace(run.workspace);
    if (run.workspace.owner.taskId !== run.taskId) {
      throw new Error("Turn workspace belongs to another Task.");
    }
    if (run.workspace.owner.type === "work-item"
      && run.workspace.owner.workItemId !== run.workItemId) {
      throw new Error("Turn workspace belongs to another Work Item.");
    }
    if (run.workspace.owner.type === "work-item" && run.workItemId === undefined) {
      throw new Error("A WorkItem workspace requires a WorkItem Turn reference.");
    }
    if (run.workspace.owner.type === "review-round" && run.purpose !== "review") {
      throw new Error("A ReviewRound workspace requires a review Turn.");
    }
    if (run.workspace.owner.type === "integration-attempt") {
      throw new Error("An IntegrationAttempt workspace cannot be used by a Turn.");
    }
    if (run.workspace.owner.type === "execution-lane") {
      if (run.workspace.owner.executionGroupId !== run.executionGroupId
        || run.workspace.owner.executionLaneId !== run.executionLaneId) {
        throw new Error("Turn Execution Lane workspace lineage does not match the Turn.");
      }
      if (run.workspace.owner.purpose === "execution"
        && run.workspace.owner.workItemId !== run.workItemId) {
        throw new Error("Turn Execution Lane workspace WorkItem does not match the Turn.");
      }
      if (run.workspace.owner.purpose === "review"
        && run.workspace.owner.reviewRoundId !== run.reviewRoundId) {
        throw new Error("Turn review Lane workspace ReviewRound does not match the Turn.");
      }
    }
    if (run.workspace.owner.type === "review-round"
      && run.workspace.owner.reviewRoundId !== run.reviewRoundId) {
      throw new Error(
        `Turn ReviewRound workspace owner does not match ${run.reviewRoundId ?? "none"}.`
      );
    }
  }
  if (run.purpose === "review") {
    if (run.reviewRoundId === undefined) {
      throw new Error("A review Turn requires a ReviewRound reference.");
    }
    if (run.workspace === undefined
      || !((run.workspace.owner.type === "review-round"
        && run.workspace.owner.reviewRoundId === run.reviewRoundId)
        || (run.workspace.owner.type === "execution-lane"
          && run.workspace.owner.purpose === "review"
          && run.workspace.owner.reviewRoundId === run.reviewRoundId))) {
      throw new Error(
        `A review Turn requires its exact ReviewRound workspace owner: ${run.reviewRoundId}.`
      );
    }
    if (run.workspace.entries.length === 0
      || run.workspace.entries.some(({ access }) => access !== "write")) {
      throw new Error("A review Turn requires only isolated writable workspace entries.");
    }
  } else {
    if (run.reviewRoundId !== undefined) {
      throw new Error("An execution Turn cannot reference a ReviewRound.");
    }
    if (run.workspace?.owner.type === "review-round") {
      throw new Error("An execution Turn cannot use a ReviewRound-owned workspace.");
    }
    if (run.workspace?.owner.type === "execution-lane" && run.workspace.owner.purpose !== "execution") {
      throw new Error("An execution Turn cannot use a review Lane workspace.");
    }
  }
  validateEffectiveLaunchSnapshot(run.effective);
  if (run.workspace !== undefined
    && (run.effective.workspace.root !== run.workspace.root
      || JSON.stringify(run.effective.workspace.entries) !== JSON.stringify(run.workspace.entries))) {
    throw new Error("Turn effective workspace does not match its managed workspace.");
  }
  if (run.purpose === "review") {
    if (run.effective.reviewRoundId !== run.reviewRoundId) {
      throw new Error("Review Turn effective provenance does not match its ReviewRound.");
    }
    if (!run.workspace!.entries.some(
      ({ baseCommit }) => baseCommit === run.effective.reviewBaseCommit
    )) {
      throw new Error("Review Turn effective base does not match its workspace.");
    }
  } else if (run.effective.reviewRoundId !== undefined) {
    throw new Error("Execution Turn cannot carry Review effective provenance.");
  }
  for (const record of run.inputs) {
    createTurnInputEnvelope(turnEnvelopeContext(run), record.input);
  }
  if (!( ["active", "completed", "failed"] as const).includes(run.status)) {
    throw new Error(`Turn status is invalid: ${String(run.status)}.`);
  }
  requireTimestamp(run.createdAt, "Turn createdAt");
  requireTimestamp(run.updatedAt, "Turn updatedAt");
  if (run.status === "active") {
    if (run.result !== undefined) throw new Error("An active Turn cannot have a result.");
  } else {
    const result = validateTurnResult(run.result);
    if (run.status === "failed") {
      if (!isTurnFailureReason(result.failureReason)) {
        throw new Error(`Failed Turn reason is invalid: ${String(result.failureReason)}.`);
      }
      if (result.systemEvidence !== undefined) {
        throw new Error("A failed Turn cannot carry successful system evidence.");
      }
    } else if (result.failureReason !== undefined) {
      throw new Error("A completed Turn cannot carry a failure reason.");
    }
  }
  return run;
}

export function completeTurn(
  run: Turn,
  output: string,
  now: Date,
  provider?: TurnProviderResult,
  systemEvidence?: TurnSystemEvidence
): Turn {
  return finishTurn(run, "completed", output, now, undefined, provider, systemEvidence);
}

export function failTurn(
  run: Turn,
  reason: TurnFailureReason,
  output: string,
  now: Date,
  provider?: TurnProviderResult
): Turn {
  return finishTurn(
    run,
    "failed",
    output,
    now,
    reason,
    provider
  );
}

function finishTurn(
  run: Turn,
  status: Exclude<TurnStatus, "active">,
  output: string,
  now: Date,
  failureReason?: TurnFailureReason,
  provider?: TurnProviderResult,
  systemEvidence?: TurnSystemEvidence
): Turn {
  if (run.status !== "active") {
    throw new Error(`Turn is already terminal: ${run.id}.`);
  }
  const timestamp = now.toISOString();
  const terminal = {
    ...run,
    status,
    result: {
      schemaVersion: 2,
      output: requireResultText(output, "Turn result output"),
      completedAt: timestamp,
      ...(provider === undefined ? {} : { provider: validateTurnProviderResult(provider) }),
      ...(systemEvidence === undefined
        ? {}
        : { systemEvidence: validateTurnSystemEvidence(systemEvidence) }),
      ...(failureReason === undefined ? {} : { failureReason })
    },
    updatedAt: timestamp,
  } as Turn;
  return validateTurn(terminal);
}

function validateTurnResult(result: TurnResult | undefined): TurnResult {
  if (result === undefined || result.schemaVersion !== 2) {
    throw new Error("A terminal Turn requires TurnResult schemaVersion 2.");
  }
  rejectUnknownFields(result as unknown as Record<string, unknown>, [
    "schemaVersion",
    "output",
    "completedAt",
    "provider",
    "systemEvidence",
    "failureReason"
  ], "Turn result");
  requireResultText(result.output, "Turn result output");
  requireTimestamp(result.completedAt, "Turn result completedAt");
  if (result.provider !== undefined) validateTurnProviderResult(result.provider);
  if (result.systemEvidence !== undefined) validateTurnSystemEvidence(result.systemEvidence);
  return result;
}

function validateTurnSystemEvidence(evidence: TurnSystemEvidence): TurnSystemEvidence {
  rejectUnknownFields(evidence as Record<string, unknown>, [
    "workspaceSnapshot"
  ], "Turn system evidence");
  if (evidence.workspaceSnapshot !== undefined) {
    const snapshot = evidence.workspaceSnapshot;
    if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.projects)) {
      throw new Error("Turn workspace snapshot is invalid.");
    }
    const projectIds = new Set<string>();
    for (const project of snapshot.projects) {
      requireSafeIdentity(project.projectId, "Turn workspace snapshot Project id");
      if (projectIds.has(project.projectId)) {
        throw new Error("Turn workspace snapshot Project ids must be unique.");
      }
      projectIds.add(project.projectId);
      if (!/^[0-9a-f]{40}$/u.test(project.headCommit)) {
        throw new Error("Turn workspace snapshot commit is invalid.");
      }
      requireText(project.branch, "Turn workspace snapshot branch");
    }
  }
  return evidence;
}

function validateTurnProviderResult(
  provider: TurnProviderResult
): TurnProviderResult {
  requireText(provider.providerNamespace, "Provider namespace");
  requireText(provider.accountScope, "Provider account scope");
  requireText(provider.conversationId, "Provider Conversation id");
  requireText(provider.activationId, "Provider Activation id");
  requireText(provider.nativeTurnId, "Provider native Turn id");
  if (!["completed", "failed", "cancelled"].includes(provider.status)) {
    throw new Error(`Provider Turn result status is invalid: ${String(provider.status)}.`);
  }
  return provider;
}

function turnInputRecord(input: TurnInput, sequence: number, submittedAt: string): TurnInputRecord {
  const normalized = validateTurnInput(input);
  return Object.freeze({
    sequence,
    submittedAt,
    input: normalized
  });
}

function turnEnvelopeContext(run: Turn): Parameters<typeof createTurnInputEnvelope>[0] {
  return {
    turnId: run.id,
    roleName: run.roleName,
    purpose: run.purpose,
    subject: {
      taskId: run.taskId,
      ...(run.workItemId === undefined ? {} : { workItemId: run.workItemId }),
      ...(run.reviewRoundId === undefined ? {} : { reviewRoundId: run.reviewRoundId }),
      ...(run.executionGroupId === undefined ? {} : {
        executionGroupId: run.executionGroupId,
        executionLaneId: run.executionLaneId!
      }),
      ...(run.sourceExecutionGroupId === undefined
        ? {}
        : { sourceExecutionGroupId: run.sourceExecutionGroupId })
    }
  };
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
  if (Buffer.byteLength(value, "utf8") > MAX_TURN_RESULT_OUTPUT_BYTES) {
    throw new Error(`${label} exceeds ${MAX_TURN_RESULT_OUTPUT_BYTES} bytes.`);
  }
  return value;
}


function requireTimestamp(value: string, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
}

function isTurnFailureReason(value: unknown): value is TurnFailureReason {
  return [
    "startup-failed",
    "runtime-failed",
    "delivery-unknown",
    "missing-result",
    "cancelled"
  ].includes(String(value));
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string
): void {
  const allowed = new Set(fields);
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown !== undefined) throw new Error(`${label} has unknown field: ${unknown}.`);
}
