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
  createRunInput,
  createRunInputEnvelope,
  validateRunInput,
  type AgentRunInput,
  type AgentRunInputEnvelope
} from "../context/runInputContract.js";
import type { ContextSnapshotRef } from "../context/contextSnapshot.js";
import type { ExecutionLaneGitSnapshot } from "../repository/executionLaneGitSnapshot.js";
import type { ProviderRuntimeBinding } from "../runtime/providerRuntimeIdentity.js";
import { providerRetryProjection } from "../runtime/providerRetry.js";
import {
  boundedRunFailureDiagnostic,
  MAX_RUN_FAILURE_DIAGNOSTIC_BYTES,
  MAX_RUN_RESULT_OUTPUT_BYTES
} from "../domain/agentResultTransport.js";
export {
  boundedRunFailureDiagnostic,
  MAX_RUN_FAILURE_DIAGNOSTIC_BYTES,
  MAX_RUN_RESULT_OUTPUT_BYTES,
  transportAgentResult,
  type TransportedAgentResult
} from "../domain/agentResultTransport.js";

export type DispatchMode = "new" | "resume";
export type AgentRunStatus = "active" | "completed" | "failed";

/** Record lifecycle and observed delivery are separate read-only facts. */
export function runExecutionObservation(run: AgentRun, binding: ProviderRuntimeBinding | null | undefined,
  events: readonly import("../event/taskEvent.js").TaskEvent[] = []) {
  const current = binding?.run?.runId === run.id ? binding.run : undefined;
  let delivery: import("../runtime/providerRuntimeIdentity.js").ProviderTurnStatus | "unobserved"
    = current?.status ?? run.result?.provider?.status ?? "unobserved";
  const lastError = events.filter((event) => event.type === "runtime.agent-error"
    && event.payload.runId === run.id && event.payload.phase === "turn-submit"
    && (current === undefined || event.payload.attemptId === current.attemptId)).at(-1);
  if ((delivery === "unobserved" || delivery === "submitting") && lastError?.payload.inputDisposition === "unknown") {
    delivery = "delivery-unknown";
  }
  return {
    recordStatus: run.status,
    delivery,
    retry: binding?.retry?.previousRunId === run.id || binding?.retry?.successorRunId === run.id
      ? providerRetryProjection(binding) : null,
    ...(current === undefined ? {} : {
      attemptId: current.attemptId, observedAt: current.updatedAt,
      ...(current.nativeTurnId === undefined ? {} : { nativeTurnId: current.nativeTurnId })
    })
  };
}
export type AgentRunPurpose = "execution" | "review" | "planning";
export type AgentRunFailureReason =
  | "startup-failed"
  | "runtime-failed"
  | "delivery-unknown"
  | "missing-result"
  | "workspace-unavailable"
  | "workspace-dirty"
  | "workspace-branch-mismatch"
  | "cancelled";

export type AgentRunProviderResult = Readonly<{
  providerNamespace: string;
  accountScope: string;
  conversationId: string;
  nativeTurnId?: string;
  /** Exact local input identity; never masquerades as a Provider Turn id. */
  attemptId?: string;
  status: "completed" | "failed" | "cancelled";
}>;

export type AgentRunSystemEvidence = Readonly<{
  workspaceSnapshot?: ExecutionLaneGitSnapshot;
}>;

/**
 * The automatically observed result of one managed Provider Turn. It is owned
 * by AgentRun; Provider Session state and Task/WorkItem acceptance remain
 * separate authorities.
 */
export type AgentRunResult = Readonly<{
  schemaVersion: 2;
  /** Exact Agent-authored terminal result, when one was transportable. */
  output?: string;
  /** Bounded Core-owned explanation for a failed AgentRun. */
  diagnostic?: string;
  completedAt: string;
  provider?: AgentRunProviderResult;
  /** Objective evidence produced and validated by Core, never parsed from Agent output. */
  systemEvidence?: AgentRunSystemEvidence;
  failureReason?: AgentRunFailureReason;
}>;

export type AgentRunInputRecord = Readonly<{
  sequence: number;
  submittedAt: string;
  input: AgentRunInput;
}>;

export type AgentRun = {
  /** v5 stores Agent output opaquely and only Core-authored system evidence. */
  schemaVersion: 5;
  id: string;
  taskId: string;
  roleName: string;
  mode: DispatchMode;
  /** Every provider-visible input, including mid-AgentRun Yui steer; reasoning is omitted. */
  inputs: readonly AgentRunInputRecord[];
  purpose: AgentRunPurpose;
  workItemId?: string;
  reviewRoundId?: string;
  /** Frozen lineage inside the unified execution Group. */
  executionGroupId?: string;
  executionLaneId?: string;
  /** The settled replicated Group whose frozen Producer results this main AgentRun synthesizes. */
  sourceExecutionGroupId?: string;
  workspace?: ManagedWorkspace;
  /** Immutable actual launch configuration and provenance. */
  effective: EffectiveLaunchSnapshot;
  status: AgentRunStatus;
  result?: AgentRunResult;
  createdAt: string;
  updatedAt: string;
};

export function createRun(
  id: string,
  taskId: string,
  roleName: string,
  mode: DispatchMode,
  input: AgentRunInput,
  now: Date,
  context: {
    workItemId?: string;
    purpose?: AgentRunPurpose;
    reviewRoundId?: string;
    executionGroupId?: string;
    executionLaneId?: string;
    sourceExecutionGroupId?: string;
    workspace?: ManagedWorkspace;
    effective: EffectiveLaunchSnapshot;
  }
): AgentRun {
  if (mode !== "new" && mode !== "resume") {
    throw new Error(`AgentRun dispatch mode is invalid: ${mode}.`);
  }
  const timestamp = now.toISOString();
  const normalizedInput = validateRunInput(input);
  return {
    schemaVersion: 5,
    id: requireSafeIdentity(id, "AgentRun id"),
    taskId: requireSafeIdentity(taskId, "Task id"),
    roleName: requireSafeIdentity(roleName, "Role name"),
    mode,
    inputs: [runInputRecord(normalizedInput, 1, timestamp)],
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

export function isActiveRun(run: AgentRun): boolean {
  return run.status === "active";
}

/**
 * The Task lifecycle a Turn of this purpose may run in.
 *
 * Delivery requires an active Task with execution admitted. Planning is the
 * Draft Leader's own conversation, so it is also admitted while the Task is
 * still a Draft; the execution gate still applies, because a stopped Task must
 * not gain a live process through the planning door. Nothing here relaxes the
 * workspace fence — a planning Turn simply has no workspace to be ready.
 */
export function runPurposeAdmitsTaskState(
  purpose: AgentRunPurpose,
  task: Readonly<{ status: string; executionGate: Readonly<{ state: string }> }>
): boolean {
  if (task.executionGate.state !== "enabled") return false;
  return purpose === "planning"
    ? task.status === "draft" || task.status === "active"
    : task.status === "active";
}

/** Binds a freshly created, not-yet-persisted Turn to its frozen Context. */
export function withRunContextSnapshot(
  run: AgentRun,
  snapshot: ContextSnapshotRef,
  deltaRefIds: readonly string[] = []
): AgentRun {
  const initial = run.inputs[0]!;
  if (run.status !== "active" || initial.input.contextSnapshotRef !== undefined) {
    throw new Error(`Cannot replace the AgentRun Context Snapshot: ${run.id}.`);
  }
  const input = createRunInput({
    ...initial.input,
    contextSnapshotRef: snapshot,
    deltaRefIds
  });
  return validateRun(Object.freeze({
    ...run,
    inputs: [runInputRecord(input, 1, initial.submittedAt), ...run.inputs.slice(1)]
  }));
}

export function appendRunInput(run: AgentRun, input: AgentRunInput, now: Date): AgentRun {
  validateRun(run);
  if (run.status !== "active") throw new Error(`Cannot append input to terminal AgentRun: ${run.id}.`);
  const timestamp = now.toISOString();
  if (Date.parse(timestamp) < Date.parse(run.updatedAt)) {
    throw new Error("AgentRun input timestamp moved backwards.");
  }
  return validateRun({
    ...run,
    inputs: [...run.inputs, runInputRecord(input, run.inputs.length + 1, timestamp)],
    updatedAt: timestamp
  });
}

/** Derives Provider-visible identity from the AgentRun, the sole semantic owner. */
export function runInputEnvelope(run: AgentRun, sequence = 1): AgentRunInputEnvelope {
  validateRun(run);
  const record = run.inputs[sequence - 1];
  if (record === undefined) throw new Error(`AgentRun input does not exist: ${run.id}/${sequence}.`);
  return createRunInputEnvelope(runEnvelopeContext(run), record.input);
}

export function validateRun(run: AgentRun): AgentRun {
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
  ], "AgentRun");
  if (run.schemaVersion !== 5) throw new Error("AgentRun must use schemaVersion 5.");
  validateTaskRecordReference({ taskId: run.taskId, localId: run.id }, "run");
  requireSafeIdentity(run.roleName, "Role name");
  if (run.mode !== "new" && run.mode !== "resume") {
    throw new Error(`AgentRun dispatch mode is invalid: ${String(run.mode)}.`);
  }
  if (!Array.isArray(run.inputs) || run.inputs.length === 0) {
    throw new Error("AgentRun requires at least one input.");
  }
  for (const [index, record] of run.inputs.entries()) {
    if (record.sequence !== index + 1) throw new Error("AgentRun input sequence is invalid.");
    requireTimestamp(record.submittedAt, "AgentRun input submittedAt");
    validateRunInput(record.input);
    if (index > 0 && Date.parse(record.submittedAt) < Date.parse(run.inputs[index - 1]!.submittedAt)) {
      throw new Error("AgentRun input timestamps moved backwards.");
    }
  }
  if (!["execution", "review", "planning"].includes(run.purpose)) {
    throw new Error(`AgentRun purpose is invalid: ${String(run.purpose)}.`);
  }
  if (run.workItemId !== undefined) {
    validateTaskRecordReference({ taskId: run.taskId, localId: run.workItemId }, "workItem");
  }
  if (run.reviewRoundId !== undefined) {
    validateTaskRecordReference({ taskId: run.taskId, localId: run.reviewRoundId }, "reviewRound");
  }
  if ((run.executionGroupId === undefined) !== (run.executionLaneId === undefined)) {
    throw new Error("AgentRun execution lineage is incomplete.");
  }
  if (run.executionGroupId !== undefined) {
    requireSafeIdentity(run.executionGroupId, "ExecutionGroup id");
    requireSafeIdentity(run.executionLaneId!, "ExecutionLane id");
  }
  if (run.sourceExecutionGroupId !== undefined) {
    requireSafeIdentity(run.sourceExecutionGroupId, "Source ExecutionGroup id");
    if (run.purpose === "planning") {
      throw new Error("A planning Turn cannot aggregate an Execution Lane group.");
    }
    if ((run.purpose === "execution" && run.workItemId === undefined)
      || (run.purpose === "review" && run.reviewRoundId === undefined)) {
      throw new Error("A source ExecutionGroup requires a main execution or review AgentRun.");
    }
    if (run.executionGroupId !== undefined || run.executionLaneId !== undefined) {
      throw new Error("A main AgentRun cannot also be an Execution Lane AgentRun.");
    }
  }
  if (run.purpose === "planning") {
    if (run.effective.executionAuthority !== "planning") {
      throw new Error("A planning AgentRun cannot hold delivery authority.");
    }
    // Draft planning is deliberately delivery-free: no WorkItem, ReviewRound,
    // Lane or workspace. That is what keeps a planning result from ever being
    // read as execution evidence or promoted into a Candidate.
    if (run.workItemId !== undefined) {
      throw new Error("A planning Turn cannot reference a Work Item.");
    }
    if (run.reviewRoundId !== undefined) {
      throw new Error("A planning Turn cannot reference a ReviewRound.");
    }
    if (run.executionGroupId !== undefined || run.executionLaneId !== undefined) {
      throw new Error("A planning Turn cannot be an Execution Lane Turn.");
    }
    if (run.workspace !== undefined) {
      throw new Error("A planning Turn cannot own a managed workspace.");
    }
  }
  if (run.workspace !== undefined) {
    validateManagedWorkspace(run.workspace);
    if (run.workspace.owner.taskId !== run.taskId) {
      throw new Error("AgentRun workspace belongs to another Task.");
    }
    if (run.workspace.owner.type === "work-item"
      && run.workspace.owner.workItemId !== run.workItemId) {
      throw new Error("AgentRun workspace belongs to another Work Item.");
    }
    if (run.workspace.owner.type === "work-item" && run.workItemId === undefined) {
      throw new Error("A WorkItem workspace requires a WorkItem AgentRun reference.");
    }
    if (run.workspace.owner.type === "review-round" && run.purpose !== "review") {
      throw new Error("A ReviewRound workspace requires a review AgentRun.");
    }
    if (run.workspace.owner.type === "integration-attempt") {
      throw new Error("An IntegrationAttempt workspace cannot be used by a AgentRun.");
    }
    if (run.workspace.owner.type === "execution-lane") {
      if (run.workspace.owner.executionGroupId !== run.executionGroupId
        || run.workspace.owner.executionLaneId !== run.executionLaneId) {
        throw new Error("AgentRun Execution Lane workspace lineage does not match the AgentRun.");
      }
      if (run.workspace.owner.purpose === "execution"
        && run.workspace.owner.workItemId !== run.workItemId) {
        throw new Error("AgentRun Execution Lane workspace WorkItem does not match the AgentRun.");
      }
      if (run.workspace.owner.purpose === "review"
        && run.workspace.owner.reviewRoundId !== run.reviewRoundId) {
        throw new Error("AgentRun review Lane workspace ReviewRound does not match the AgentRun.");
      }
    }
    if (run.workspace.owner.type === "review-round"
      && run.workspace.owner.reviewRoundId !== run.reviewRoundId) {
      throw new Error(
        `AgentRun ReviewRound workspace owner does not match ${run.reviewRoundId ?? "none"}.`
      );
    }
  }
  if (run.purpose === "review") {
    if (run.reviewRoundId === undefined) {
      throw new Error("A review AgentRun requires a ReviewRound reference.");
    }
    if (run.workspace === undefined
      || !((run.workspace.owner.type === "review-round"
        && run.workspace.owner.reviewRoundId === run.reviewRoundId)
        || (run.workspace.owner.type === "execution-lane"
          && run.workspace.owner.purpose === "review"
          && run.workspace.owner.reviewRoundId === run.reviewRoundId))) {
      throw new Error(
        `A review AgentRun requires its exact ReviewRound workspace owner: ${run.reviewRoundId}.`
      );
    }
    if (run.workspace.entries.length === 0
      || run.workspace.entries.some(({ access }) => access !== "write")) {
      throw new Error("A review AgentRun requires only isolated writable workspace entries.");
    }
  } else {
    if (run.reviewRoundId !== undefined) {
      throw new Error("An execution AgentRun cannot reference a ReviewRound.");
    }
    if (run.workspace?.owner.type === "review-round") {
      throw new Error("An execution AgentRun cannot use a ReviewRound-owned workspace.");
    }
    if (run.workspace?.owner.type === "execution-lane" && run.workspace.owner.purpose !== "execution") {
      throw new Error("An execution AgentRun cannot use a review Lane workspace.");
    }
  }
  validateEffectiveLaunchSnapshot(run.effective);
  if (run.workspace !== undefined
    && (run.effective.workspace.root !== run.workspace.root
      || JSON.stringify(run.effective.workspace.entries) !== JSON.stringify(run.workspace.entries))) {
    throw new Error("AgentRun effective workspace does not match its managed workspace.");
  }
  if (run.purpose === "review") {
    if (run.effective.reviewRoundId !== run.reviewRoundId) {
      throw new Error("Review AgentRun effective provenance does not match its ReviewRound.");
    }
    if (!run.workspace!.entries.some(
      ({ baseCommit }) => baseCommit === run.effective.reviewBaseCommit
    )) {
      throw new Error("Review AgentRun effective base does not match its workspace.");
    }
  } else if (run.effective.reviewRoundId !== undefined) {
    throw new Error("Execution AgentRun cannot carry Review effective provenance.");
  }
  for (const record of run.inputs) {
    createRunInputEnvelope(runEnvelopeContext(run), record.input);
  }
  if (!( ["active", "completed", "failed"] as const).includes(run.status)) {
    throw new Error(`AgentRun status is invalid: ${String(run.status)}.`);
  }
  requireTimestamp(run.createdAt, "AgentRun createdAt");
  requireTimestamp(run.updatedAt, "AgentRun updatedAt");
  if (run.status === "active") {
    if (run.result !== undefined) throw new Error("An active AgentRun cannot have a result.");
  } else {
    const result = validateRunResult(run.result);
    if (run.status === "failed") {
      if (!isRunFailureReason(result.failureReason)) {
        throw new Error(`Failed AgentRun reason is invalid: ${String(result.failureReason)}.`);
      }
      if (result.diagnostic === undefined) {
        throw new Error("A failed AgentRun requires a Core diagnostic.");
      }
      if (result.systemEvidence !== undefined) {
        throw new Error("A failed AgentRun cannot carry successful system evidence.");
      }
    } else {
      if (result.output === undefined) {
        throw new Error("A completed AgentRun requires an Agent result.");
      }
      if (result.failureReason !== undefined || result.diagnostic !== undefined) {
        throw new Error("A completed AgentRun cannot carry failure metadata.");
      }
    }
  }
  return run;
}

export function completeRun(
  run: AgentRun,
  output: string,
  now: Date,
  provider?: AgentRunProviderResult,
  systemEvidence?: AgentRunSystemEvidence
): AgentRun {
  return finishRun(run, "completed", output, now, undefined, provider, systemEvidence);
}

export function failRun(
  run: AgentRun,
  reason: AgentRunFailureReason,
  diagnostic: string,
  now: Date,
  provider?: AgentRunProviderResult,
  output?: string
): AgentRun {
  return finishRun(
    run,
    "failed",
    output,
    now,
    reason,
    provider,
    undefined,
    boundedRunFailureDiagnostic(diagnostic)
  );
}

function finishRun(
  run: AgentRun,
  status: Exclude<AgentRunStatus, "active">,
  output: string | undefined,
  now: Date,
  failureReason?: AgentRunFailureReason,
  provider?: AgentRunProviderResult,
  systemEvidence?: AgentRunSystemEvidence,
  diagnostic?: string
): AgentRun {
  if (run.status !== "active") {
    throw new Error(`AgentRun is already terminal: ${run.id}.`);
  }
  const timestamp = now.toISOString();
  const terminal = {
    ...run,
    status,
    result: {
      schemaVersion: 2,
      ...(output === undefined ? {} : { output: requireResultText(output, "AgentRun result output") }),
      ...(diagnostic === undefined
        ? {}
        : { diagnostic: requireDiagnosticText(diagnostic, "AgentRun result diagnostic") }),
      completedAt: timestamp,
      ...(provider === undefined ? {} : { provider: validateRunProviderResult(provider) }),
      ...(systemEvidence === undefined
        ? {}
        : { systemEvidence: validateRunSystemEvidence(systemEvidence) }),
      ...(failureReason === undefined ? {} : { failureReason })
    },
    updatedAt: timestamp,
  } as AgentRun;
  return validateRun(terminal);
}

function validateRunResult(result: AgentRunResult | undefined): AgentRunResult {
  if (result === undefined || result.schemaVersion !== 2) {
    throw new Error("A terminal AgentRun requires AgentRunResult schemaVersion 2.");
  }
  rejectUnknownFields(result as unknown as Record<string, unknown>, [
    "schemaVersion",
    "output",
    "diagnostic",
    "completedAt",
    "provider",
    "systemEvidence",
    "failureReason"
  ], "AgentRun result");
  if (result.output !== undefined) requireResultText(result.output, "AgentRun result output");
  if (result.diagnostic !== undefined) {
    requireDiagnosticText(result.diagnostic, "AgentRun result diagnostic");
  }
  requireTimestamp(result.completedAt, "AgentRun result completedAt");
  if (result.provider !== undefined) validateRunProviderResult(result.provider);
  if (result.systemEvidence !== undefined) validateRunSystemEvidence(result.systemEvidence);
  return result;
}

function validateRunSystemEvidence(evidence: AgentRunSystemEvidence): AgentRunSystemEvidence {
  rejectUnknownFields(evidence as Record<string, unknown>, [
    "workspaceSnapshot"
  ], "AgentRun system evidence");
  if (evidence.workspaceSnapshot !== undefined) {
    const snapshot = evidence.workspaceSnapshot;
    if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.projects)) {
      throw new Error("AgentRun workspace snapshot is invalid.");
    }
    const projectIds = new Set<string>();
    for (const project of snapshot.projects) {
      requireSafeIdentity(project.projectId, "AgentRun workspace snapshot Project id");
      if (projectIds.has(project.projectId)) {
        throw new Error("AgentRun workspace snapshot Project ids must be unique.");
      }
      projectIds.add(project.projectId);
      if (!/^[0-9a-f]{40}$/u.test(project.headCommit)) {
        throw new Error("AgentRun workspace snapshot commit is invalid.");
      }
      requireText(project.branch, "AgentRun workspace snapshot branch");
    }
  }
  return evidence;
}

function validateRunProviderResult(
  provider: AgentRunProviderResult
): AgentRunProviderResult {
  requireText(provider.providerNamespace, "Provider namespace");
  requireText(provider.accountScope, "Provider account scope");
  requireText(provider.conversationId, "Provider Conversation id");
  if (provider.nativeTurnId !== undefined) requireText(provider.nativeTurnId, "Provider native Turn id");
  if (provider.attemptId !== undefined) requireText(provider.attemptId, "Provider attempt id");
  if (provider.nativeTurnId === undefined && provider.attemptId === undefined) {
    throw new Error("Provider result requires a native Turn or exact attempt identity.");
  }
  if (!["completed", "failed", "cancelled"].includes(provider.status)) {
    throw new Error(`Provider AgentRun result status is invalid: ${String(provider.status)}.`);
  }
  return provider;
}

function runInputRecord(input: AgentRunInput, sequence: number, submittedAt: string): AgentRunInputRecord {
  const normalized = validateRunInput(input);
  return Object.freeze({
    sequence,
    submittedAt,
    input: normalized
  });
}

function runEnvelopeContext(run: AgentRun): Parameters<typeof createRunInputEnvelope>[0] {
  return {
    runId: run.id,
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
  if (Buffer.byteLength(value, "utf8") > MAX_RUN_RESULT_OUTPUT_BYTES) {
    throw new Error(`${label} exceeds ${MAX_RUN_RESULT_OUTPUT_BYTES} bytes.`);
  }
  return value;
}

function requireDiagnosticText(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} is invalid.`);
  if (value.trim().length === 0) throw new Error(`${label} is required.`);
  if (Buffer.byteLength(value, "utf8") > MAX_RUN_FAILURE_DIAGNOSTIC_BYTES) {
    throw new Error(`${label} exceeds ${MAX_RUN_FAILURE_DIAGNOSTIC_BYTES} bytes.`);
  }
  return value;
}


function requireTimestamp(value: string, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
}

function isRunFailureReason(value: unknown): value is AgentRunFailureReason {
  return [
    "startup-failed",
    "runtime-failed",
    "delivery-unknown",
    "missing-result",
    "workspace-unavailable",
    "workspace-dirty",
    "workspace-branch-mismatch",
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
